import { createHmac, timingSafeEqual } from 'node:crypto';

import { IAccessTokens } from '@Contexts/Groups/Application/Ports/IAccessTokens';

/**
 * Tokens that prove an account: the account's id, signed with a key only the application's file holds (the
 * key is kept in that file, so every server on it accepts what any of them issued). A token is
 * `<id, base64url>.<signature, base64url>`; one whose signature does not match proves nothing.
 */
export class HmacAccessTokens implements IAccessTokens {
  constructor(private key: string) {}

  issue(accountId: string): string {
    const body = Buffer.from(accountId).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  verify(token: string): string | null {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) return null;

    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    return Buffer.from(body, 'base64url').toString() || null;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}
