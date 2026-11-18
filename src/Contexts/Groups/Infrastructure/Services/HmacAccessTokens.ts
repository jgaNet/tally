import { createHmac, timingSafeEqual } from 'node:crypto';

import { IAccessTokens } from '@Contexts/Groups/Application/Ports/IAccessTokens';

/**
 * Tokens that prove an account: the account's id, signed with a key only the application's database holds (the
 * key is kept in that database, so every server on it accepts what any of them issued). A token is
 * `<id, base64url>.<signature, base64url>`; one whose signature does not match proves nothing.
 *
 * The key comes from a provider, called on first use and not before: it reads the database, which is open only
 * once the application has started. The key is then kept for the rest of the process; a provider that fails is
 * asked again on the next use.
 */
export class HmacAccessTokens implements IAccessTokens {
  #key?: Promise<string>;

  constructor(private keyProvider: () => Promise<string>) {}

  async issue(accountId: string): Promise<string> {
    const body = Buffer.from(accountId).toString('base64url');
    return `${body}.${await this.sign(body)}`;
  }

  async verify(token: string): Promise<string | null> {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) return null;

    const expected = Buffer.from(await this.sign(body));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    return Buffer.from(body, 'base64url').toString() || null;
  }

  private async sign(body: string): Promise<string> {
    const key = await this.signingKey();
    return createHmac('sha256', key).update(body).digest('base64url');
  }

  private signingKey(): Promise<string> {
    this.#key ??= this.keyProvider().catch(error => {
      this.#key = undefined;
      throw error;
    });
    return this.#key;
  }
}
