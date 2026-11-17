import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { ITokens } from '@Contexts/Groups/Application/Ports/ITokens';
import { ACCOUNT_STATEMENTS } from '@Contexts/Groups/Infrastructure/accounts.schema';

/**
 * Tokens signed with a secret that lives in the database file, generated once: every server on
 * the same file issues and verifies the same tokens, and a restart verifies what an earlier run
 * issued. A token is `<account id>.<signature>`; it carries no time, so it is never read as
 * changed by the passing of time.
 */
export class HmacTokens implements ITokens {
  readonly #secret: Buffer;

  constructor(database: SqliteDatabase) {
    database.migrate(ACCOUNT_STATEMENTS);
    database.connection
      .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('token_secret', ?)")
      .run(randomBytes(32).toString('base64'));
    const row = database.connection.prepare("SELECT value FROM settings WHERE key = 'token_secret'").get() as {
      value: string;
    };
    this.#secret = Buffer.from(row.value, 'base64');
  }

  issue(accountId: string): string {
    return `${accountId}.${this.sign(accountId)}`;
  }

  verify(token: string): string | null {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const accountId = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.sign(accountId));
    return given.length === expected.length && timingSafeEqual(given, expected) ? accountId : null;
  }

  private sign(accountId: string): string {
    return createHmac('sha256', this.#secret).update(accountId).digest('base64url');
  }
}
