import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { IPasswordHasher } from '@Contexts/Groups/Application/Ports/IPasswordHasher';

const KEY_LENGTH = 32;

const derive = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, (error, key) => (error ? reject(error) : resolve(key))),
  );

/** Passwords hashed with scrypt and a salt of their own, as `scrypt$<salt>$<key>` (both in base64). */
export class ScryptPasswordHasher implements IPasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    return `scrypt$${salt.toString('base64')}$${(await derive(password, salt)).toString('base64')}`;
  }

  /** A hash this class did not make (or none at all) matches nothing, after the same work as one that did. */
  async verify(password: string, hash: string): Promise<boolean> {
    const [scheme, salt, key] = hash.split('$');
    const known = scheme === 'scrypt' && Boolean(salt) && Boolean(key);
    const expected = known ? Buffer.from(key, 'base64') : Buffer.alloc(KEY_LENGTH);
    const actual = await derive(password, known ? Buffer.from(salt, 'base64') : Buffer.alloc(16));
    return known && expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
