import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ISessionTokens } from '@Contexts/Groups/Application/Ports/ISessionTokens';

const KEY_NAME = 'session-token-key';

/**
 * Signed tokens, `<payload>.<signature>`: the payload is the account's id in base64url, the signature its
 * HMAC-SHA256 under a key. The key is random and kept in the application's database (table `secrets`), so
 * every server on the database signs and checks with the same one and a token outlives a restart (docs/adr/0002).
 * A token has no expiry and no record of its own: it proves its account, and nothing else.
 *
 * The key is made by a seed of the database (the first server to prepare it makes it, the others keep it) and held in
 * memory, so `issue` and `accountOf` stay synchronous.
 */
export class PostgresSessionTokens implements ISessionTokens {
  #key?: Buffer;

  constructor(database: PostgresDatabase) {
    database.prepare(async db => {
      await db.exec('CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    });
    database.seed(async db => {
      await db.run('INSERT INTO secrets (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', [
        KEY_NAME,
        randomBytes(32).toString('base64'),
      ]);
      const row = await db.get<{ value: string }>('SELECT value FROM secrets WHERE name = ?', [KEY_NAME]);
      if (!row) throw new Error('The session token key is missing from the database');
      this.#key = Buffer.from(row.value, 'base64');
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

  /** The key the seed loaded. A token is signed only once the database is prepared: the seed has run by then. */
  #keyBytes(): Buffer {
    if (!this.#key) throw new Error('The session token key is not loaded: the database must be prepared first');
    return this.#key;
  }
}
