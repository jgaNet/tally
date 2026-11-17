import { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

/**
 * The one SQLite file an application keeps what it knows in (`DATABASE_PATH`, ADR 2), opened once per process.
 *
 * Several servers may run on the same file: the journal is write-ahead, so a reader never waits for a writer,
 * and a writer waits (up to `BUSY_TIMEOUT_MS`) for the one before it. Inside a process, one connection is
 * shared by every request, and `lock()` is what keeps one request's transaction from containing another's
 * writes: whoever writes outside a transaction of its own goes through `exclusive()`.
 */
export class SqliteDatabase {
  static readonly BUSY_TIMEOUT_MS = 15_000;

  readonly #connection: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #tail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {
    this.#connection = new DatabaseSync(path);
    this.#connection.exec(`PRAGMA busy_timeout = ${SqliteDatabase.BUSY_TIMEOUT_MS}`);
    this.#connection.exec('PRAGMA journal_mode = WAL');
    this.#connection.exec('PRAGMA synchronous = FULL');
  }

  /** Runs statements that take no parameter (a schema, a transaction's begin or end). */
  exec(sql: string): void {
    this.#connection.exec(sql);
  }

  /** One write; says how many rows it changed. */
  run(sql: string, ...parameters: SQLInputValue[]): number {
    return Number(this.statement(sql).run(...parameters).changes);
  }

  get<Row>(sql: string, ...parameters: SQLInputValue[]): Row | undefined {
    return this.statement(sql).get(...parameters) as Row | undefined;
  }

  all<Row>(sql: string, ...parameters: SQLInputValue[]): Row[] {
    return this.statement(sql).all(...parameters) as Row[];
  }

  /**
   * A value this file keeps once for everyone who opens it (a signing secret): the first server to ask makes it,
   * and every other, at the same time or later, reads that one.
   */
  setting(key: string, create: () => string): string {
    this.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', key, create());
    return (this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key) as { value: string }).value;
  }

  /** Waits for the transaction in progress, if any, and holds the connection until the release it answers is called. */
  async lock(): Promise<() => void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>(resolve => (release = resolve));
    await previous;
    return release;
  }

  /** Runs a read or a write that has no transaction of its own, after the transaction in progress has ended. */
  async exclusive<T>(work: () => T): Promise<T> {
    const release = await this.lock();
    try {
      return work();
    } finally {
      release();
    }
  }

  close(): void {
    this.#connection.close();
  }

  private statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#connection.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}

const opened = new Map<string, SqliteDatabase>();

/**
 * The application's database: the file `DATABASE_PATH` names, one connection per process however many modules
 * ask. Without it the data lives in memory and goes with the process (the unit and end-to-end suites).
 */
export function sharedDatabase(path: string = process.env.DATABASE_PATH || ':memory:'): SqliteDatabase {
  let database = opened.get(path);
  if (!database) {
    database = new SqliteDatabase(path);
    opened.set(path, database);
  }
  return database;
}
