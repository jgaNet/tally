import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { IPasswordHasher } from '@Contexts/Groups/Application/IPasswordHasher';

const KEY_LENGTH = 64;
/** The salt of the work done for an unknown email, so that it costs what a known one does. */
const NO_ACCOUNT_SALT = Buffer.alloc(16);

/** Passwords hashed with scrypt, each with its own random salt: stored as `salt.hash`, both base64url. */
export class ScryptPasswordHasher implements IPasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    return `${salt.toString('base64url')}.${(await derive(password, salt)).toString('base64url')}`;
  }

  async matches(password: string, hash: string | undefined): Promise<boolean> {
    if (hash === undefined) {
      await derive(password, NO_ACCOUNT_SALT);
      return false;
    }
    const [salt, expected] = hash.split('.');
    if (!salt || !expected) return false;
    const actual = await derive(password, Buffer.from(salt, 'base64url'));
    const stored = Buffer.from(expected, 'base64url');
    return stored.length === actual.length && timingSafeEqual(stored, actual);
  }
}

const derive = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_LENGTH, (error, key) => (error ? reject(error) : resolve(key))),
  );
