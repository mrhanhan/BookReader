import { eq } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { libraries } from '../db/schema';

/** Fixed id of the single shared library, chosen so concurrent first use converges. */
export const LIBRARY_ID = '00000000-0000-7000-8000-000000000001';

/** Display name of the shared library. */
export const LIBRARY_NAME = '书房';

/**
 * Returns the single shared library, inserting it on first use. The insert is
 * idempotent, so two concurrent first requests cannot create two shelves.
 */
export async function getLibrary(deps: AppDeps): Promise<{ id: string; name: string }> {
  await deps.db
    .insert(libraries)
    .values({ id: LIBRARY_ID, name: LIBRARY_NAME })
    .onConflictDoNothing({ target: libraries.id });

  const [library] = await deps.db
    .select({ id: libraries.id, name: libraries.name })
    .from(libraries)
    .where(eq(libraries.id, LIBRARY_ID))
    .limit(1);

  if (!library) {
    throw new Error('The shared library row could not be created');
  }
  return library;
}
