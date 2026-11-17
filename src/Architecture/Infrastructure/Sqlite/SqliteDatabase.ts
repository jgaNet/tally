import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * The application's state, in one SQLite file (Node's built-in SQLite): every context's stores and the
 * transactional outbox live in it, so a transaction writes them together and a rollback undoes them
 * together (ADR 24, ADR 2).
 *
 * One connection per process. The process takes its turn at the file with `acquire()`: a transaction
 * holds that turn from its begin to its commit or rollback, and every read or write that is not part of
 * a transaction waits for the turn with `exclusive()`. So no statement of one request lands inside
 * another request's transaction, and a rollback undoes only its own writes. Across processes, SQLite's
 * own locks serialise the writes (`BEGIN IMMEDIATE`, and a busy timeout), so several servers may share
 * the file. A transaction awaits only what it must, and the turn is kept for its duration, so it is
 * short: a slow step is one that does not hold the file.
 */
export class SqliteDatabase {
  readonly connection: DatabaseSync;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.connection = new DatabaseSync(path);
    this.connection.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /** Waits for the process's turn at the file; the returned function gives it back. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const turn = new Promise<void>(resolve => (release = resolve));
    const previous = this.#tail;
    this.#tail = previous.then(() => turn);
    return previous.then(() => release);
  }

  /** Runs one read or write outside any transaction, after a transaction in progress has ended. */
  async exclusive<T>(run: (connection: DatabaseSync) => T): Promise<T> {
    const release = await this.acquire();
    try {
      return run(this.connection);
    } finally {
      release();
    }
  }

  /**
   * A secret the file keeps for the application: created the first time any server opens the file, and
   * read back by every server after it, so that a token signed by one is accepted by all of them.
   */
  secret(name: string): string {
    this.connection
      .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .run(name, randomBytes(32).toString('base64url'));
    const row = this.connection.prepare('SELECT value FROM settings WHERE key = ?').get(name) as { value: string };
    return row.value;
  }
}
