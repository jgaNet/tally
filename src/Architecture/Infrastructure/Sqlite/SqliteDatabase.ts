import { DatabaseSync } from 'node:sqlite';

/**
 * The application's one SQLite database: the file `DATABASE_PATH` names (ADR 2).
 *
 * One connection per process, and several processes may open the same file. Within a process
 * the connection is synchronous, so an open transaction would take in whatever else is written
 * meanwhile; `exclusive()` and the unit of work therefore take one turn at a time, in the order
 * they asked. Between processes the file's own lock decides: a transaction begins `IMMEDIATE`,
 * so the second writer waits (`busy_timeout`) for the first to commit and then reads what it left.
 *
 * Rules for the code that uses it:
 * - a repository, inside a command's transaction, uses `connection` directly: the transaction
 *   already holds the turn;
 * - anything that is not in a transaction (a query, a record written on the side, the outbox's
 *   bookkeeping) goes through `exclusive()`, which waits for the transaction in progress.
 */
export class SqliteDatabase {
  static #shared?: SqliteDatabase;

  /** The process's database, opened on first use from `DATABASE_PATH` (in memory under test). */
  static shared(): SqliteDatabase {
    return (SqliteDatabase.#shared ??= new SqliteDatabase(
      process.env.DATABASE_PATH || (process.env.NODE_ENV === 'test' ? ':memory:' : 'tally.sqlite'),
    ));
  }

  readonly connection: DatabaseSync;
  #tail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {
    this.connection = new DatabaseSync(path);
    this.connection.exec('PRAGMA busy_timeout = 30000');
    if (path !== ':memory:') this.connection.exec('PRAGMA journal_mode = WAL');
    this.connection.exec('PRAGMA synchronous = FULL');
    this.connection.exec('PRAGMA foreign_keys = ON');
  }

  /** Creates what a store needs, idempotently: every statement is `CREATE … IF NOT EXISTS`. */
  migrate(statements: string[]): void {
    for (const statement of statements) this.connection.exec(statement);
  }

  /** Waits for its turn on the connection; the function it returns gives the turn back. */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const turn = new Promise<void>(resolve => (release = resolve));
    const previous = this.#tail;
    this.#tail = previous.then(() => turn);
    await previous;
    return release;
  }

  /** Runs `fn` on the connection outside any other transaction of this process. */
  async exclusive<T>(fn: (connection: DatabaseSync) => T): Promise<T> {
    const release = await this.acquire();
    try {
      return fn(this.connection);
    } finally {
      release();
    }
  }

  close(): void {
    if (this.connection.isOpen) this.connection.close();
  }
}
