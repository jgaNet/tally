import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ISessionTokens } from '@Contexts/Groups/Application/ISessionTokens';
import { Role } from '@SharedKernel/Domain';

/** The setting the database keeps the signing key under: one for every server on the file (ADR 2). */
const KEY_SETTING = 'groups.session-token-key';

/** What a token proves: the account, and the role the sign-in gave it (request 33). */
interface Claims {
  readonly accountId: string;
  readonly role: Role;
}

/**
 * Tokens signed with HMAC-SHA256: `<base64url of the claims>.<signature>`, the claims being the account id and its role. A token is issued
 * with no record kept, and is accepted by every server that shares the key, after a restart too. A token does not expire: a sign-out and
 * expiry are a feature of their own.
 */
export class SignedSessionTokens implements ISessionTokens {
  constructor(private readonly key: string) {}

  /** The tokens of the database's servers: the key is made by the first server to start, and kept there. */
  static async open(database: PostgresDatabase): Promise<SignedSessionTokens> {
    return new SignedSessionTokens(await database.setting(KEY_SETTING, () => randomBytes(32).toString('base64url')));
  }

  issue(accountId: string, role: Role = Role.USER): string {
    const payload = Buffer.from(JSON.stringify({ accountId, role }), 'utf8').toString('base64url');
    return `${payload}.${this.#sign(payload)}`;
  }

  accountOf(token: string): string | undefined {
    return this.#claimsOf(token)?.accountId;
  }

  roleOf(token: string): Role {
    return this.#claimsOf(token)?.role ?? Role.USER;
  }

  #claimsOf(token: string): Claims | undefined {
    const parts = token.split('.');
    if (parts.length !== 2) return undefined;
    const [payload, signature] = parts;
    if (!payload || !signature || !safeEqual(signature, this.#sign(payload))) return undefined;
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    try {
      const claims = JSON.parse(decoded) as { accountId?: unknown; role?: unknown };
      if (typeof claims.accountId !== 'string' || claims.accountId === '') return undefined;
      return { accountId: claims.accountId, role: claims.role === Role.ADMIN ? Role.ADMIN : Role.USER };
    } catch {
      // A token an earlier server signed carries the bare account id, as a user's: it still proves who they are (ADR 28).
      return decoded === '' ? undefined : { accountId: decoded, role: Role.USER };
    }
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
