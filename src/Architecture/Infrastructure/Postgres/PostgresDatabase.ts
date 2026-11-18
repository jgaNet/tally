import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { Pool, PoolClient, QueryResult } from 'pg';

/**
 * The connection of the transaction a unit of work runs (ADR 20). Queries made while a transaction's scope runs use its
 * connection, so that a transaction's reads see its own writes and nothing else's; the unit of work sets it at begin and
 * clears it at commit or rollback.
 */
export interface TransactionScope {
  client?: PoolClient;
}

/** The advisory lock every write transaction takes: one at a time across the servers that share the database (ADR 20). */
export const WRITES_LOCK = 7310001;
/** The advisory lock the schema is made under, and a file moved under: a second server waits, then finds it done. */
const SETUP_LOCK = 7310002;

/** Given before the database serves, in the setup transaction, with what the database held when it began. */
export type BeforeServing = (client: PoolClient, fresh: boolean) => Promise<void>;

/**
 * The application's state, in one PostgreSQL database (ADR 20): every context's tables, the transactional outbox and the
 * operation records, in the database `DATABASE_URL` names. Each context's adapter declares the DDL of its tables with
 * `define()` when it is constructed, and the database makes them, once, when it is opened: in one transaction under one
 * advisory lock, with the step given to `open()` (the move of a SQLite file, ADR 20), so that a crash leaves nothing
 * half made and a second server waits for the first to finish.
 *
 * Reads that are not part of a transaction run on the pool and see what is committed (PostgreSQL's read committed; ADR 2,
 * ADR 4). A transaction takes a connection of its own, and its scope (`inScope()`) carries it to the queries it makes.
 * Writes are serialised as they were under SQLite: one transaction at a time in the process (the turn) and across the
 * servers that share the database (the advisory lock, taken at the transaction's begin).
 *
 * Statements are written with `?` placeholders, as they were for SQLite; they are numbered for PostgreSQL here, outside
 * quoted text.
 */
export class PostgresDatabase {
  readonly #pool: Pool;
  readonly #ddl: string[] = [];
  #opened?: Promise<void>;
  #turn: Promise<void> = Promise.resolve();
  readonly #scope = new AsyncLocalStorage<TransactionScope>();

  constructor(connectionString: string, { poolSize = 10 }: { poolSize?: number } = {}) {
    this.#pool = new Pool({ connectionString, max: poolSize });
    this.define(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /**
   * Declares DDL the database makes when it is opened: idempotent statements only (`CREATE ... IF NOT EXISTS`,
   * `ADD COLUMN IF NOT EXISTS`). Called by an adapter's constructor, which runs no query.
   */
  define(ddl: string): void {
    this.#ddl.push(ddl);
  }

  /**
   * Makes the declared schema, then runs `beforeServing`, in one transaction under the setup lock, and resolves when both
   * are committed. It is opened once; the first call decides what runs (the composition root's, before any query).
   * Every query before it is refused: a database that is not open answers nothing.
   */
  open(beforeServing?: BeforeServing): Promise<void> {
    return (this.#opened ??= this.#setUp(beforeServing));
  }

  async #setUp(beforeServing?: BeforeServing): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
      // A database that holds nothing of Tally's has no settings table yet: the first DDL below makes it.
      const { rows } = await client.query<{ table: string | null }>("SELECT to_regclass('settings') AS table");
      const fresh = rows[0]?.table === null;
      await client.query(this.#ddl.join('\n'));
      await beforeServing?.(client, fresh);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.#opened = undefined;
      throw error;
    } finally {
      client.release();
    }
  }

  /** A read or a write outside any transaction of its own, or inside the scope's transaction when it runs in one. */
  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.#query(sql, params)).rows[0] as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.#query(sql, params)).rows as T[];
  }

  /** A write; `changes` is the number of rows it touched. */
  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = await this.#query(sql, params);
    return { changes: result.rowCount ?? 0 };
  }

  /** Statements without parameters, several at once allowed: for DDL. */
  async exec(sql: string): Promise<void> {
    await this.#query(sql, []);
  }

  async #query(sql: string, params: unknown[]): Promise<QueryResult> {
    if (!this.#opened) throw new Error('The database is not open: open() it before its first query');
    await this.#opened;
    const text = toPositional(sql);
    const scope = this.#scope.getStore();
    if (scope?.client) return scope.client.query(text, params);
    return this.#pool.query(text, params);
  }

  /** Runs `run` in the scope of a transaction: the queries it makes on the database use the scope's connection (ADR 4). */
  inScope<T>(scope: TransactionScope, run: () => Promise<T>): Promise<T> {
    return this.#scope.run(scope, run);
  }

  /** The process's turn for writes: waits for the transaction in progress, if any, and returns the function that gives it back. */
  acquireTurn(): Promise<() => void> {
    let release!: () => void;
    const turn = new Promise<void>(resolve => (release = resolve));
    const previous = this.#turn;
    this.#turn = previous.then(() => turn);
    return previous.then(() => release);
  }

  /** A connection for a transaction of its own; it is given back with `release()`. */
  async connect(): Promise<PoolClient> {
    if (!this.#opened) throw new Error('The database is not open: open() it before its first transaction');
    await this.#opened;
    return this.#pool.connect();
  }

  /**
   * The application's secret, kept in the database: created the first time any server opens it, and read back by every
   * server after it, so a token signed by one is accepted by all of them (ADR 2, ADR 20).
   */
  async secret(name: string): Promise<string> {
    await this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [
      name,
      randomBytes(32).toString('base64url'),
    ]);
    const row = await this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [name]);
    return row!.value;
  }

  /** Gives the connections back. The application stops with it. */
  async close(): Promise<void> {
    await this.#pool.end();
  }
}

/** `?` placeholders become `$1, $2, ...`, outside quoted text: the statements are written as they were for SQLite. */
export function toPositional(sql: string): string {
  let index = 0;
  let quoted = false;
  let out = '';
  for (const char of sql) {
    if (char === "'") quoted = !quoted;
    if (char === '?' && !quoted) out += `$${++index}`;
    else out += char;
  }
  return out;
}
