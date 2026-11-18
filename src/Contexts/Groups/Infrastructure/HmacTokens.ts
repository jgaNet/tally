import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { ITokens } from '@Contexts/Groups/Application/Ports/ITokens';
import { ACCOUNT_STATEMENTS } from '@Contexts/Groups/Infrastructure/accounts.schema';

/**
 * Tokens signed with a secret that lives in the database, generated once: every server on the
 * same database issues and verifies the same tokens, and a restart verifies what an earlier run
 * issued — a secret moved from the SQLite file included (ADR 22), so a token issued before the
 * move still signs in. A token is `<account id>.<signature>`; it carries no time, so it is never
 * read as changed by the passing of time. The secret is read by `load()`, which the composition
 * root calls once the database is prepared, before the server serves.
 */
export class HmacTokens implements ITokens {
  #secret: Buffer | null = null;

  constructor(private readonly database: PostgresDatabase) {
    database.migrate(ACCOUNT_STATEMENTS);
  }

  /** Reads the secret, generating it the first time: the first server to write it wins, and every other reads it. */
  async load(): Promise<void> {
    const row = await this.database.exclusive(async connection => {
      await connection.run(
        "INSERT INTO settings (key, value) VALUES ('token_secret', ?) ON CONFLICT (key) DO NOTHING",
        randomBytes(32).toString('base64'),
      );
      return connection.row<{ value: string }>("SELECT value FROM settings WHERE key = 'token_secret'");
    });
    this.#secret = Buffer.from((row as { value: string }).value, 'base64');
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
    if (!this.#secret) throw new Error('The tokens are used before their secret was loaded');
    return createHmac('sha256', this.#secret).update(accountId).digest('base64url');
  }
}
