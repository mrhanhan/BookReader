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

  // The fresh lease keeps the job out of a second claim.
  expect(await queue.claimNext()).toBeNull();
});
