import { DatabaseSync } from 'node:sqlite';

/** How long a statement waits for another server on the same file to let go of the write lock, in ms. */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * What the building blocks keep in the database: the outbox (ADR 24) and a few settings a server must
 * agree on with every other server on the file (ADR 2). A context adds its own tables to `open()`.
 */
const BUILDING_BLOCKS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS outbox (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     payload TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/**
 * The database a process shares, over one file that any number of servers may open (ADR 2).
 *
 * Two connections. The writer holds the transactions: `begin()` takes the process's write turn and
 * `BEGIN IMMEDIATE`s, so one transaction at a time writes, here and in every other server on the file
 * (SQLite's lock, with a busy timeout). The reader answers the reads that are not part of a transaction:
 * in WAL mode it sees what is committed and is never blocked by a writer. Because the writer serves one
 * transaction at a time, its statements never interleave with another request's.
 *
 * Reads are synchronous and run to completion; a use case reads what is committed. A transaction's
 * own uncommitted writes are visible to its writer only, so a use case reads before it writes (or
 * through the writer, passed in by its adapter).
 *
 * A write outside a transaction (`writeAlone()`) takes the same turn, so it never lands inside another
 * request's transaction. It must not be called from inside a transaction: the turn is not reentrant.
 */
export class SqliteDatabase {
  readonly #writer: DatabaseSync;
  readonly #reader: DatabaseSync;
  /** The tail of the queue of transactions: each waits for the one before it to leave the turn. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The turn the open transaction holds, given back at its commit or rollback. */
  #leave: (() => void) | undefined;

  private constructor(path: string, schema: readonly string[]) {
    this.#writer = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS, enableForeignKeyConstraints: true });
    this.#writer.exec('PRAGMA journal_mode = WAL');
    for (const statement of [...BUILDING_BLOCKS_SCHEMA, ...schema]) this.#writer.exec(statement);

    this.#reader = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
    this.#reader.exec('PRAGMA query_only = ON');
  }

  /** Opens (creating it if need be) the database at `path`, with the tables of `schema` beside the building blocks'. */
  static open(path: string, schema: readonly string[] = []): SqliteDatabase {
    return new SqliteDatabase(path, schema);
  }

  /** The committed data, now: a read that is not part of any transaction. */
  read<T>(query: (db: DatabaseSync) => T): T {
    return query(this.#reader);
  }

  /** The writer, for the statements of the transaction that holds it (between `begin()` and its end). */
  get writer(): DatabaseSync {
    return this.#writer;
  }

  /** A write of its own, outside any transaction, on the turn: other transactions wait for it. */
  async writeAlone<T>(write: (db: DatabaseSync) => T): Promise<T> {
    const leave = await this.#takeTurn();
    try {
      return write(this.#writer);
    } finally {
      leave();
    }
  }

  /** Takes the turn, then opens the transaction on it. The turn is given back at `commit()` or `rollback()`. */
  async begin(): Promise<void> {
    const leave = await this.#takeTurn();
    try {
      this.#writer.exec('BEGIN IMMEDIATE');
    } catch (error) {
      leave();
      throw error;
    }
    this.#leave = leave;
  }

  /** Makes the transaction's writes durable and gives the turn back. If the commit fails, nothing is kept. */
  commit(): void {
    try {
      this.#writer.exec('COMMIT');
    } catch (error) {
      this.#rollbackAfterFailedCommit();
      throw error;
    } finally {
      this.#giveTurnBack();
    }
  }

  /** Undoes the transaction's writes and gives the turn back. */
  rollback(): void {
    try {
      this.#writer.exec('ROLLBACK');
    } finally {
      this.#giveTurnBack();
    }
  }

  /**
   * A value kept under `name`, the same for every server on the file: `make()` is called only when there is
   * none yet, and the one that lands first is kept (ADR 2). Used for what must not differ between servers,
   * such as the key tokens are signed with.
   */
  async setting(name: string, make: () => string): Promise<string> {
    const read = () =>
      this.read(
        db => db.prepare('SELECT value FROM settings WHERE name = ?').get(name) as { value: string } | undefined,
      );
    const existing = read();
    if (existing) return existing.value;
    await this.writeAlone(db =>
      db.prepare('INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)').run(name, make()),
    );
    const kept = read();
    if (!kept) throw new Error(`The setting ${name} was not kept`);
    return kept.value;
  }

  close(): void {
    this.#writer.close();
    this.#reader.close();
  }

  #takeTurn(): Promise<() => void> {
    const previous = this.#queue;
    let leave!: () => void;
    this.#queue = new Promise<void>(resolve => {
      leave = resolve;
    });
    return previous.then(() => leave);
  }

  #giveTurnBack(): void {
    const leave = this.#leave;
    this.#leave = undefined;
    leave?.();
  }

  #rollbackAfterFailedCommit(): void {
    try {
      this.#writer.exec('ROLLBACK');
    } catch {
      // SQLite may already have ended the transaction when the commit failed: nothing is left to undo.
    }
  }
}
