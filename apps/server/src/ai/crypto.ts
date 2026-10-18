import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config';

/** AES-256-GCM output; every part is stored base64 encoded. */
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const HKDF_SALT = 'bookr-ai-config-salt';
const HKDF_INFO = 'bookr-ai-config-v1';
const DECRYPT_ERROR = 'Could not decrypt the AI key';

/**
 * Derives the AES key that protects the provider API key. HKDF separates it
 * from the JWT signing key even when both come from the same secret.
 */
export function deriveConfigKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, KEY_LENGTH));
}

/** Picks the dedicated AI secret when configured, else the JWT secret. */
export function configKeyFor(config: Pick<AppConfig, 'jwtSecret' | 'ai'>): Buffer {
  return deriveConfigKey(config.ai.configSecret ?? config.jwtSecret);
}

/** Encrypts the API key with a fresh random IV for every write. */
export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypts a stored API key. Failures are deliberately indistinguishable: the
 * message never contains ciphertext, identifiers or the underlying error.
 */
export function decryptSecret(secret: EncryptedSecret, key: Buffer): string {
  try {
    const iv = Buffer.from(secret.iv, 'base64');
    const tag = Buffer.from(secret.tag, 'base64');
    if (iv.length !== IV_LENGTH || tag.length !== GCM_TAG_LENGTH || key.length !== KEY_LENGTH) {
      throw new Error(DECRYPT_ERROR);
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(DECRYPT_ERROR);
  }
}
