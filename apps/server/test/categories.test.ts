import { ERROR_CODES } from '@bookr/shared';
import { expect, it } from 'vitest';
import { bookCategories } from '../src/db/schema';
import { authHeader, buildTestApp, resetDb, seedBook, seedUser, testDb } from './helpers';

/**
 * Waits until the category assignment has reached the `book_categories`
 * insert and is blocked on the concurrent, still-uncommitted delete. Polling
 * the server's own activity makes the race deterministic instead of relying
 * on a sleep.
 */
async function waitForBlockedInsert(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await testDb.$client.query<{ blocked: boolean }>(
      `select exists (
         select 1 from pg_stat_activity
         where datname = current_database()
           and wait_event_type = 'Lock'
           and query ilike '%insert into "book_categories"%'
       ) as blocked`,
    );
    if (rows[0]?.blocked) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the book_categories insert never blocked on the concurrent delete');
}

it('lets members create categories and lists them for everyone', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const created = await app.inject({
    method: 'POST',
    url: '/api/categories',
    headers: await authHeader(alice),
    payload: { name: '历史', color: '#8C5A3B' },
  });
  expect(created.statusCode).toBe(201);
  const list = await app.inject({
    method: 'GET',
    url: '/api/categories',
    headers: await authHeader(bob),
  });
  expect(list.json().items).toHaveLength(1);
});

it('forbids members from renaming or deleting categories', async () => {
  await resetDb();
  const app = await buildTestApp();
  const member = await seedUser('member');
  const admin = await seedUser('admin', 'admin');
  const category = (
    await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: await authHeader(member),
      payload: { name: '历史', color: '#8C5A3B' },
    })
  ).json();
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/categories/${category.id}`,
        headers: await authHeader(member),
        payload: { name: '改名' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/categories/${category.id}`,
        headers: await authHeader(member),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/categories/${category.id}`,
        headers: await authHeader(admin),
        payload: { name: '改名' },
      })
    ).statusCode,
  ).toBe(200);
});

it('assigns categories to books and detaches them on delete without deleting the book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const book = await seedBook({ uploadedBy: admin.id });
  const category = (
    await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: await authHeader(admin),
      payload: { name: '小说', color: '#5B6B8C' },
    })
  ).json();
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/books/${book.id}`,
    headers: await authHeader(admin),
    payload: { categoryIds: [category.id] },
  });
  expect(patched.json().book.categories).toHaveLength(1);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/categories/${category.id}`,
        headers: await authHeader(admin),
      })
    ).statusCode,
  ).toBe(204);
  expect(await testDb.select().from(bookCategories)).toHaveLength(0);
  expect(
    (
      await app.inject({
        method: 'GET',
        url: `/api/books/${book.id}`,
        headers: await authHeader(admin),
      })
    ).statusCode,
  ).toBe(200);
});

it(
  'returns a conflict instead of a 500 when a category is deleted mid-assignment',
  async () => {
    await resetDb();
    const app = await buildTestApp();
    const admin = await seedUser('admin');
    const book = await seedBook({ uploadedBy: admin.id });
    const category = (
      await app.inject({
        method: 'POST',
        url: '/api/categories',
        headers: await authHeader(admin),
        payload: { name: '稍后删除', color: '#5B6B8C' },
      })
    ).json();
    const headers = await authHeader(admin);

    // A second connection deletes the category but keeps the transaction open,
    // so the assignment's FK check has to wait and then fail after COMMIT.
    const blocker = await testDb.$client.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('DELETE FROM categories WHERE id = $1', [category.id]);

      const pending = app.inject({
        method: 'PATCH',
        url: `/api/books/${book.id}`,
        headers,
        payload: { categoryIds: [category.id] },
      });
      await waitForBlockedInsert();
      await blocker.query('COMMIT');

      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(ERROR_CODES.CONFLICT);
    } finally {
      blocker.release();
    }
  },
  15_000,
);
