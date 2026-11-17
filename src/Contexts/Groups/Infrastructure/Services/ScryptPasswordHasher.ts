import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { IPasswordHasher } from '@Contexts/Groups/Domain/Account/Ports/IPasswordHasher';

const KEY_LENGTH = 64;

/**
 * The password hasher over Node's scrypt: a salt per password, the hash kept as `scrypt$<salt>$<key>`, the
 * comparison constant-time. Nothing of the password is kept, and the algorithm is only here, behind the port.
 */
export class ScryptPasswordHasher implements IPasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt, KEY_LENGTH);
    return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  async verify(password: string, hash: string): Promise<boolean> {
    const [scheme, salt, key] = hash.split('$');
    if (scheme !== 'scrypt' || !salt || !key) return false;
    const expected = Buffer.from(key, 'base64');
    const actual = await derive(password, Buffer.from(salt, 'base64'), expected.length);
    return timingSafeEqual(actual, expected);
  }
}

function derive(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, length, (error, key) => (error ? reject(error) : resolve(key))),
  );
}
