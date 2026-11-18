import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ITokenIssuer } from '@Contexts/Groups/Application/Ports/ITokenIssuer';

/**
 * A token is `<payload>.<signature>`: the account it names and its expiry, signed with a secret the database
 * keeps once for every server on it, so a token is good on any of them and after any restart.
 */
export class HmacTokenIssuer implements ITokenIssuer {
  static readonly LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

  constructor(private secret: string | (() => string)) {}

  static inDatabase(database: PostgresDatabase): HmacTokenIssuer {
    return new HmacTokenIssuer(database.setting('token-secret', () => randomBytes(32).toString('hex')));
  }

  issue(accountId: string, now: Date): string {
    const payload = Buffer.from(JSON.stringify({ sub: accountId, exp: now.getTime() + HmacTokenIssuer.LIFETIME_MS }));
    const encoded = payload.toString('base64url');
    return `${encoded}.${this.sign(encoded)}`;
  }

  verify(token: string, now: Date): string | null {
    const [encoded, signature, ...rest] = token.split('.');
    if (!encoded || !signature || rest.length) return null;

    const expected = Buffer.from(this.sign(encoded));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

    try {
      const { sub, exp } = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { sub?: unknown; exp?: unknown };
      return typeof sub === 'string' && typeof exp === 'number' && exp > now.getTime() ? sub : null;
    } catch {
      return null;
    }
  }

  private sign(encoded: string): string {
    return createHmac('sha256', typeof this.secret === 'string' ? this.secret : this.secret())
      .update(encoded)
      .digest('base64url');
  }
}
