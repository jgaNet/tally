import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { IPasswordHasher } from '@Contexts/Groups/Application/Ports/IPasswordHasher';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 64;

/**
 * Hashes passwords with scrypt and a fresh random salt, and keeps the result as `scrypt$<salt>$<key>` in
 * base64. Checking a password derives its key with the stored salt and compares the two in constant time.
 */
export class ScryptPasswordHasher implements IPasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scryptAsync(password, salt, KEY_LENGTH);
    return ['scrypt', salt.toString('base64'), key.toString('base64')].join('$');
  }

  async matches(password: string, hash: string): Promise<boolean> {
    const [scheme, salt, key] = hash.split('$');
    if (scheme !== 'scrypt' || !salt || !key) return false;
    const expected = Buffer.from(key, 'base64');
    const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
    return timingSafeEqual(actual, expected);
  }
}
