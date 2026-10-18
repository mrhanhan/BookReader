import { argon2id, hash, verify, type HashOptions } from 'argon2';

/** Argon2id parameters chosen to match the OWASP baseline. */
const HASH_OPTIONS: HashOptions = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Hashes a plaintext password with Argon2id. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

/** Checks a plaintext password against a stored Argon2id hash. */
export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await verify(hashValue, password);
  } catch {
    // A malformed or unsupported hash is a failed match, not a server error.
    return false;
  }
}
