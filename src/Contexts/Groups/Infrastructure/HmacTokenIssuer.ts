import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { isRole, Role } from '@SharedKernel/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ITokenIssuer } from '@Contexts/Groups/Application/Ports/ITokenIssuer';

/**
 * A token is `<payload>.<signature>`: the account it names, its role and its expiry, signed with a secret the database keeps once for
 * every server on it, so a token is good on any of them and after any restart.
 */
export class HmacTokenIssuer implements ITokenIssuer {
  static readonly LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

  constructor(private secret: string | (() => string)) {}

  static inDatabase(database: PostgresDatabase): HmacTokenIssuer {
    return new HmacTokenIssuer(database.setting('token-secret', () => randomBytes(32).toString('hex')));
  }

  issue(accountId: string, role: Role, now: Date): string {
    const payload = Buffer.from(
      JSON.stringify({ sub: accountId, role, exp: now.getTime() + HmacTokenIssuer.LIFETIME_MS }),
    );
    const encoded = payload.toString('base64url');
    return `${encoded}.${this.sign(encoded)}`;
  }

  verify(token: string, now: Date): { accountId: string; role: Role } | null {
    const [encoded, signature, ...rest] = token.split('.');
    if (!encoded || !signature || rest.length) return null;

    const expected = Buffer.from(this.sign(encoded));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

    try {
      const { sub, role, exp } = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as {
        sub?: unknown;
        role?: unknown;
        exp?: unknown;
      };
      if (typeof sub !== 'string' || typeof exp !== 'number' || exp <= now.getTime()) return null;
      // A token issued before roles were kept names no role: it is an ordinary member's, as it always was.
      return { accountId: sub, role: isRole(role) ? role : Role.USER };
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
