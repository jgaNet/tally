import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const COST = { N: 16384, r: 8, p: 1 };

export interface PasswordHash {
  /** Hex-encoded random salt. */
  salt: string;
  /** Hex-encoded scrypt output. */
  hash: string;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, COST);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const expected = Buffer.from(stored.hash, 'hex');
  const actual = await scrypt(password, Buffer.from(stored.salt, 'hex'), expected.length, COST);
  return timingSafeEqual(actual, expected);
}

/**
 * A hash of nothing in particular. Signing in with an email no account has checks a password
 * against this, so that the time taken does not tell whether the email has an account.
 */
export const DECOY_PASSWORD_HASH: Promise<PasswordHash> = hashPassword('decoy-password-for-timing');
