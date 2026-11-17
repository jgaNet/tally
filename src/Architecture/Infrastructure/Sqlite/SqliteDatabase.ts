import { DatabaseSync } from 'node:sqlite';

/**
 * The application's database: one SQLite file, named by `DATABASE_PATH` (docs/adr/0002). Every
 * store of every context is a table in it, and so is the outbox (ADR 24).
 *
 * Two rules make it safe to share in one process, and SQLite makes them safe across processes:
 *
 * - One transaction at a time per process. A unit of work takes the file's turn (`acquire()`) when
 *   its transaction begins and gives it back when the transaction ends; a read of the file takes it
 *   for the one statement (`exclusive()`). Without that, one request's uncommitted writes would be
 *   read by another request on the same connection.
 * - Across processes (several servers on one file), a transaction begins with `BEGIN IMMEDIATE`, so
 *   a second writer waits for the first (`busy_timeout`) and never reads its uncommitted rows.
 *
 * Stores run only inside a transaction: `assertInTransaction()` says so where a store is used.
 *
 * The file is opened on first use, so importing the wiring does not touch the disk; what each
 * adapter needs in the schema is registered with `prepare()` and run once, when the file opens.
 */
export class SqliteDatabase {
  readonly #path: () => string;
  readonly #setups: Array<(connection: DatabaseSync) => void> = [];
  #connection?: DatabaseSync;
  #tail: Promise<void> = Promise.resolve();
  #inTransaction = false;

  constructor(path: () => string = () => process.env.DATABASE_PATH || 'tally.db') {
    this.#path = path;
    this.prepare(connection =>
      connection.exec(
        'CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, payload TEXT NOT NULL)',
      ),
    );
  }

  /** Runs `setup` once, when the file is opened (or now, if it is open already): a schema, a row an adapter needs. */
  prepare(setup: (connection: DatabaseSync) => void): void {
    if (this.#connection) setup(this.#connection);
    else this.#setups.push(setup);
  }

  /** The connection, opened on first use with the schema every adapter registered. */
  get connection(): DatabaseSync {
    if (!this.#connection) {
      const connection = new DatabaseSync(this.#path());
      connection.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      for (const setup of this.#setups) setup(connection);
      this.#connection = connection;
    }
    return this.#connection;
  }

  /** Waits for the file's turn in this process. Resolves to the function that gives it back. */
  acquire(): Promise<() => void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>(resolve => (release = resolve));
    return previous.then(() => release);
  }

  /** Runs one synchronous operation on the file, alone: the read of a query, or the one statement of an outbox. */
  async exclusive<T>(operation: () => T): Promise<T> {
    const release = await this.acquire();
    try {
      return operation();
    } finally {
      release();
    }
  }

  /** Whether a transaction of this process is open: set by the unit of work that holds the file. */
  get inTransaction(): boolean {
    return this.#inTransaction;
  }

  setInTransaction(open: boolean): void {
    this.#inTransaction = open;
  }

  /** A store is used inside a transaction only: a read or a write outside one would not be isolated. */
  assertInTransaction(): void {
    if (!this.#inTransaction) {
      throw new Error(
        'A store is used inside a transaction only: the use case that reads or writes it must run in one',
      );
    }
  }
}

/** The application's database: every unit of work of the process writes to this file. */
export const sharedDatabase = new SqliteDatabase();
