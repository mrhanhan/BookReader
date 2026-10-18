import { v7 as uuidv7 } from 'uuid';

/** Generates a time-ordered UUIDv7, used for every primary key in the system. */
export function newId(): string {
  return uuidv7();
}
