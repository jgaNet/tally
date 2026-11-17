import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISessionTokens } from '@Contexts/Groups/Application/ISessionTokens';

/** The setting the database keeps the signing key under: one for every server on the file (ADR 2). */
const KEY_SETTING = 'groups.session-token-key';

/**
 * Tokens signed with HMAC-SHA256: `<base64url of the account id>.<signature>`. A token is issued with no record
 * kept, and is accepted by every server that shares the key, after a restart too. A token does not expire: a sign-out
 * and expiry are a feature of their own.
 */
export class SignedSessionTokens implements ISessionTokens {
  constructor(private readonly key: string) {}

  /** The tokens of the database's servers: the key is made by the first server to start, and kept there. */
  static async open(database: SqliteDatabase): Promise<SignedSessionTokens> {
    return new SignedSessionTokens(await database.setting(KEY_SETTING, () => randomBytes(32).toString('base64url')));
  }

  issue(accountId: string): string {
    const payload = Buffer.from(accountId, 'utf8').toString('base64url');
    return `${payload}.${this.#sign(payload)}`;
  }

  accountOf(token: string): string | undefined {
    const parts = token.split('.');
    if (parts.length !== 2) return undefined;
    const [payload, signature] = parts;
    if (!payload || !signature || !safeEqual(signature, this.#sign(payload))) return undefined;
    return Buffer.from(payload, 'base64url').toString('utf8');
  }

  #sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }
}

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
