import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { noteAnalyses, users } from '../src/db/schema';
import { resetDb, seedUser, testDb } from './helpers';

it('stores analysis rows with streaming defaults', async () => {
  await resetDb();
  const user = await seedUser('member');

  const [row] = await testDb
    .insert(noteAnalyses)
    .values({
      userId: user.id,
      status: 'streaming',
      kind: 'themes',
      title: '主题分析',
      scope: {},
      noteCount: 3,
      analyzedCount: 3,
    })
    .returning();

  expect(row!.content).toBe('');
  expect(row!.promptTokens).toBe(0);
  expect(row!.completionTokens).toBe(0);
  expect(row!.createdAt).toBeInstanceOf(Date);
});

it('cascades analyses when their owner is deleted', async () => {
  await resetDb();
  const user = await seedUser('member');

  await testDb.insert(noteAnalyses).values({
    userId: user.id,
    status: 'complete',
    kind: 'viewpoints',
    title: '观点梳理',
    scope: { tag: '论点' },
    noteCount: 1,
    analyzedCount: 1,
  });

  await testDb.delete(users).where(eq(users.id, user.id));
  expect(await testDb.select().from(noteAnalyses)).toHaveLength(0);
});

it('creates the note search indexes', async () => {
  await resetDb();

  const { rows } = await testDb.$client.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
  );
  const names = rows.map((row) => row.indexname);
  expect(names).toContain('annotations_user_updated_idx');
  expect(names).toContain('annotations_tags_idx');
});
