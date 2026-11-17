import { randomBytes, scrypt, timingSafeEqual } from 'crypto';

import { IPasswordHasher } from '@Contexts/Groups/Application/IPasswordHasher';

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/**
 * Passwords hashed with scrypt (the platform's, no dependency): `scrypt$<salt>$<key>`, the salt random for each
 * password, the comparison constant-time. A hash this does not read proves no password.
 */
export class ScryptPasswordHasher implements IPasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await derive(password, salt);
    return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  async matches(password: string, hash: string): Promise<boolean> {
    const [scheme, salt, expected] = hash.split('$');
    if (scheme !== 'scrypt' || !salt || !expected) return false;
    const key = await derive(password, Buffer.from(salt, 'base64url'));
    const wanted = Buffer.from(expected, 'base64url');
    return wanted.length === key.length && timingSafeEqual(key, wanted);
  }
}

const derive = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_LENGTH, (error, key) => (error ? reject(error) : resolve(key))),
  );
