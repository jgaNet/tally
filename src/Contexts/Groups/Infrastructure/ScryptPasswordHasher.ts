import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

import { IPasswordHasher } from '@Contexts/Groups/Domain/Account/Ports/IPasswordHasher';

/**
 * scrypt with a salt of its own for each password: `scrypt$<salt>$<hash>`, both in base64.
 * It is synchronous on purpose: the sign-up hashes inside its transaction, which must not wait on anything but
 * the file (ADR 2), and the work is a few tens of milliseconds.
 */
export class ScryptPasswordHasher implements IPasswordHasher {
  static readonly KEY_LENGTH = 32;

  hash(password: string): string {
    const salt = randomBytes(16);
    return `scrypt$${salt.toString('base64')}$${this.derive(password, salt).toString('base64')}`;
  }

  matches(password: string, hash: string): boolean {
    const [scheme, salt, expected] = hash.split('$');
    if (scheme !== 'scrypt' || !salt || !expected) return false;
    const wanted = Buffer.from(expected, 'base64');
    const derived = this.derive(password, Buffer.from(salt, 'base64'));
    return wanted.length === derived.length && timingSafeEqual(wanted, derived);
  }

  private derive(password: string, salt: Buffer): Buffer {
    return scryptSync(password.normalize('NFKC'), salt, ScryptPasswordHasher.KEY_LENGTH);
  }
}
