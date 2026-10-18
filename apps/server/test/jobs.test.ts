import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { jobs } from '../src/db/schema';
import { PostgresJobQueue } from '../src/jobs/queue';
import { buildTestDeps, resetDb, testDb } from './helpers';

it('reclaims a running job whose worker lease expired', async () => {
  await resetDb();
  const deps = await buildTestDeps();
  const queue = new PostgresJobQueue(deps.db, deps.clock);
  await queue.enqueue({
    type: 'metadata',
    bookId: '00000000-0000-7000-8000-000000000099',
  });

  const first = await queue.claimNext();
  expect(first?.type).toBe('metadata');

  // Simulate a worker that crashed while holding the job: still running, but
  // its lease is older than the five-minute reclaim window.
  await testDb
    .update(jobs)
    .set({ lockedAt: new Date(Date.now() - 10 * 60 * 1000) })
    .where(eq(jobs.id, first!.id));

  const reclaimed = await queue.claimNext();
  expect(reclaimed?.id).toBe(first!.id);
  // Reclaiming a crashed worker's lease counts as a failed attempt.
  expect(reclaimed?.attempts).toBe(1);

  // The fresh lease keeps the job out of a second claim.
  expect(await queue.claimNext()).toBeNull();
});

it('fails a job whose lease expires after the last allowed attempt', async () => {
  await resetDb();
  const deps = await buildTestDeps();
  const queue = new PostgresJobQueue(deps.db, deps.clock);
  await queue.enqueue({
    type: 'metadata',
    bookId: '00000000-0000-7000-8000-000000000098',
  });

  const first = await queue.claimNext();
  expect(first?.attempts).toBe(0);

  // The worker crashed twice already and then crashed again while running.
  await testDb
    .update(jobs)
    .set({ attempts: first!.maxAttempts - 1, lockedAt: new Date(Date.now() - 10 * 60 * 1000) })
    .where(eq(jobs.id, first!.id));

  await queue.claimNext();

  const [row] = await testDb.select().from(jobs).where(eq(jobs.id, first!.id));
  expect(row!.status).toBe('failed');
  expect(row!.attempts).toBe(first!.maxAttempts);
  expect(row!.lastError).toMatch(/lease expired/i);
});

