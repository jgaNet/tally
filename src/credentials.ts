import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const COST = { N: 16384, r: 8, p: 1 };

function derive(password: string, salt: Buffer, cost: typeof COST, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, cost, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** A salted scrypt hash of the password, as one string: `scrypt$N$r$p$salt$key`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST, KEY_LENGTH);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, key] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(
    password,
    Buffer.from(salt, 'base64'),
    { N: Number(n), r: Number(r), p: Number(p) },
    expected.length,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A new bearer token: 256 random bits, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as this hash, so the database alone does not reveal a token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
