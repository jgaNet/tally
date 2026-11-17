import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISessionTokens } from '@Contexts/Groups/Application/Ports/ISessionTokens';

const KEY_NAME = 'session-token-key';

/**
 * Signed tokens, `<payload>.<signature>`: the payload is the account's id in base64url, the signature its
 * HMAC-SHA256 under a key. The key is random and kept in the application's database (table `secrets`), so
 * every server on the file signs and checks with the same one and a token outlives a restart (docs/adr/0002).
 * A token has no expiry and no record of its own: it proves its account, and nothing else.
 */
export class SqliteSessionTokens implements ISessionTokens {
  #key?: Buffer;

  constructor(private readonly database: SqliteDatabase) {
    // Created once, when the file opens: the first server to open it makes the key, the others find it.
    database.prepare(connection => {
      connection.exec('CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
      connection
        .prepare('INSERT OR IGNORE INTO secrets (name, value) VALUES (?, ?)')
        .run(KEY_NAME, randomBytes(32).toString('base64'));
    });
  }

  issue(accountId: string): string {
    const payload = Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url');
    return `${payload}.${this.#sign(payload)}`;
  }

  accountOf(token: string): string | undefined {
    const [payload, signature, ...rest] = token.split('.');
    if (!payload || !signature || rest.length > 0) return undefined;
    const expected = Buffer.from(this.#sign(payload));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    try {
      const { sub } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: unknown };
      return typeof sub === 'string' && sub.length > 0 ? sub : undefined;
    } catch {
      return undefined;
    }
  }

  #sign(payload: string): string {
    return createHmac('sha256', this.#keyBytes()).update(payload).digest('base64url');
  }

  /** The key, read once from the file (the connection getter opens the file when nothing has yet). */
  #keyBytes(): Buffer {
    this.#key ??= Buffer.from(
      (this.database.connection.prepare('SELECT value FROM secrets WHERE name = ?').get(KEY_NAME) as { value: string })
        .value,
      'base64',
    );
    return this.#key;
  }
}
