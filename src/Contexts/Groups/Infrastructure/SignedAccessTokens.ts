import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { IAccessTokens } from '@Contexts/Groups/Application/IAccessTokens';

import { GroupsDatabase } from './GroupsDatabase';

/**
 * Tokens of the form `accountId.nonce.signature`, the signature an HMAC-SHA256 over the first two parts with a key
 * generated once and kept in the database. The nonce makes each sign-in's token its own; the key makes a token one
 * only this application can have made.
 */
export class SignedAccessTokens implements IAccessTokens {
  constructor(private readonly database: GroupsDatabase) {}

  async issue(accountId: string): Promise<string> {
    const payload = `${accountId}.${randomBytes(16).toString('base64url')}`;
    return `${payload}.${await this.sign(payload)}`;
  }

  async accountOf(token: string): Promise<string | undefined> {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const [accountId, nonce, signature] = parts;
    const given = Buffer.from(signature);
    const expected = Buffer.from(await this.sign(`${accountId}.${nonce}`));
    return given.length === expected.length && timingSafeEqual(given, expected) ? accountId : undefined;
  }

  private async sign(payload: string): Promise<string> {
    return createHmac('sha256', await this.key())
      .update(payload)
      .digest('base64url');
  }

  /** The signing key, written once when the tables are set up (`GroupsDatabase`), so that signing only reads it. */
  private async key(): Promise<string> {
    const row = await this.database.row<{ value: string }>("SELECT value FROM settings WHERE key = 'token_key'");
    return row?.value as string;
  }
}
