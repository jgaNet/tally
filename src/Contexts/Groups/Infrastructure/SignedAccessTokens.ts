import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { IAccessTokens } from '@Contexts/Groups/Application/IAccessTokens';

import { GroupsDatabase } from './GroupsDatabase';

const ADMINISTRATOR = 'administrator';

/**
 * Tokens of the form `accountId.nonce.signature`, or `accountId.nonce.administrator.signature` for an administrator's sign-in (request 33), the signature an HMAC-SHA256 over the first two parts with a key
 * generated once and kept in the database. The nonce makes each sign-in's token its own; the key makes a token one
 * only this application can have made.
 */
export class SignedAccessTokens implements IAccessTokens {
  constructor(private readonly database: GroupsDatabase) {}

  async issue(accountId: string, administrator = false): Promise<string> {
    const nonce = randomBytes(16).toString('base64url');
    // The role is part of what is signed: only a sign-in of an administrator's account makes an administrator's token.
    const payload = administrator ? `${accountId}.${nonce}.${ADMINISTRATOR}` : `${accountId}.${nonce}`;
    return `${payload}.${await this.sign(payload)}`;
  }

  async accountOf(token: string): Promise<{ accountId: string; administrator: boolean } | undefined> {
    const parts = token.split('.');
    if (parts.length !== 3 && parts.length !== 4) return undefined;
    const signature = parts[parts.length - 1];
    const payload = parts.slice(0, -1);
    if (payload.length === 3 && payload[2] !== ADMINISTRATOR) return undefined;
    const given = Buffer.from(signature);
    const expected = Buffer.from(await this.sign(payload.join('.')));
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? { accountId: payload[0], administrator: payload.length === 3 }
      : undefined;
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
