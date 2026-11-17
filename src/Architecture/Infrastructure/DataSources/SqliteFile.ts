import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The files a transaction is open on, in the async chain that opened it: a transaction begun inside one of them joins it. */
const openFiles = new AsyncLocalStorage<ReadonlySet<SqliteFile>>();

/**
 * One SQLite file of the process, opened once at the path it is named by, with the one connection every context of this process
 * writes it through, and the gate that makes its writes take turns (ADR 17).
 *
 * A decision that reads state and then writes it must read and write in one transaction on the file, or another writer may
 * change what it read in between. `transaction()` opens that transaction: writers wait for the gate in this process, and
 * `BEGIN IMMEDIATE` makes writers in other processes (other servers on the same file) wait for it too, so the transaction is
 * the only writer while it lasts. A transaction begun inside another one on the same file joins it, so a repository's write is
 * the same transaction as the use case that decided it. A transaction whose work throws rolls back what it wrote.
 *
 * Reads take no gate: they read what is committed, and see a transaction's writes only while it is open on the one connection
 * (an honest limit, ADR 17).
 */
export class SqliteFile {
  static readonly #files = new Map<string, SqliteFile>();
  readonly #path: string;
  #connection?: DatabaseSync;
  #turn: Promise<void> = Promise.resolve();

  private constructor(path: string) {
    this.#path = path;
  }

  /** The file at `path`, the same object for the same file, whichever context names it. */
  static of(path: string): SqliteFile {
    const key = resolve(path);
    const existing = SqliteFile.#files.get(key);
    if (existing) return existing;
    const file = new SqliteFile(key);
    SqliteFile.#files.set(key, file);
    return file;
  }

  /** The one connection of the process to this file, opened on first use with WAL and a busy timeout. */
  get connection(): DatabaseSync {
    if (!this.#connection) {
      const connection = new DatabaseSync(this.#path);
      connection.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
      this.#connection = connection;
    }
    return this.#connection;
  }

  /**
   * Runs `work` in a transaction on the file: committed when it resolves, rolled back and re-thrown when it throws. Nested in a
   * transaction on this file, in the same async chain, it runs inside that one. Otherwise it waits for the file's turn in this
   * process, then begins the transaction (`BEGIN IMMEDIATE`, which waits in turn for the other servers on the file).
   */
  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    const open = openFiles.getStore() ?? new Set<SqliteFile>();
    if (open.has(this)) return work();

    const previous = this.#turn;
    let release!: () => void;
    this.#turn = new Promise<void>(resolveTurn => (release = resolveTurn));
    try {
      await previous;
      const connection = this.connection;
      return await openFiles.run(new Set([...open, this]), async () => {
        connection.exec('BEGIN IMMEDIATE');
        try {
          const result = await work();
          connection.exec('COMMIT');
          return result;
        } catch (error) {
          if (connection.isTransaction) connection.exec('ROLLBACK');
          throw error;
        }
      });
    } finally {
      release();
    }
  }

  /**
   * Sets up a schema on the file, idempotently: in its own transaction when none is open on the connection, so that it is kept;
   * inside an open one it joins that transaction, and is not kept if that transaction rolls back. Answers whether it was kept, so a
   * context sets it up again on its next use when it was not.
   */
  schema(setup: (connection: DatabaseSync) => void): boolean {
    const connection = this.connection;
    if (connection.isTransaction) {
      setup(connection);
      return false;
    }
    connection.exec('BEGIN IMMEDIATE');
    try {
      setup(connection);
      connection.exec('COMMIT');
      return true;
    } catch (error) {
      if (connection.isTransaction) connection.exec('ROLLBACK');
      throw error;
    }
  }
}
