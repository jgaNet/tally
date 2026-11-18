import { AsyncLocalStorage } from 'node:async_hooks';

import pg from 'pg';

const { Pool, types } = pg;

// BIGINT and COUNT(*) come back as numbers, as SQLite returned them: a count or an amount is never a string.
types.setTypeParser(types.builtins.INT8, value => Number(value));

/** The key of the advisory lock every write transaction takes, in every process on the database (docs/adr/0029). */
const TALLY_LOCK = 7405131;

/**
 * `?` placeholders, as the stores write them, turned into PostgreSQL's `$1, $2, …`. A `?` inside a quoted literal is
 * text, not a placeholder.
 */
export function positional(sql: string): string {
  let index = 0;
  let inLiteral = false;
  let out = '';
  for (const character of sql) {
    if (character === "'") inLiteral = !inLiteral;
    out += character === '?' && !inLiteral ? `$${++index}` : character;
  }
  return out;
}

/**
 * A transaction's scope: the connection it holds, bound to the async flow that opened it (`beginScope()`), so a store
 * read or written anywhere in that flow uses the transaction, and nothing outside the flow does.
 */
export interface TransactionScope {
  client?: pg.PoolClient;
}

export interface Row {
  [column: string]: unknown;
}

/** A schema step: a table, an index, a column a later version added. Run once, when the database is prepared. */
export type Setup = (database: PostgresDatabase) => Promise<void>;

/**
 * The application's database: one PostgreSQL database, named by `DATABASE_URL` (docs/adr/0029). Every store of every
 * context is a table in it, and so is the outbox (ADR 24) and the bus's inbox.
 *
 * Two rules keep a unit of work's reads and writes apart from another's, as the SQLite file did (docs/adr/0002):
 *
 * - One transaction at a time per process. A unit of work takes the process's turn (`acquire()`) when its transaction
 *   begins and gives it back when the transaction ends; a read that is not in a unit's transaction takes it for the
 *   one statement (`exclusive()`), so it never sees another request's uncommitted rows.
 * - Across processes (several servers on one database), every transaction takes a transaction-scoped advisory lock
 *   when it begins, so a second writer waits for the first, as `BEGIN IMMEDIATE` made it wait on the file.
 *
 * Stores run only inside a transaction: `assertInTransaction()` says so where a store is used.
 *
 * The connection pool is opened on first use. What each adapter needs in the schema is registered with `prepare()`
 * and run once, when the database is prepared (Bootstrap/Database/prepareDatabase.ts), and what must be in place
 * after a move from a file is registered with `seed()`.
 */
export class PostgresDatabase {
  readonly #url: () => string;
  readonly #setups: Setup[] = [];
  readonly #seeds: Setup[] = [];
  #pool?: pg.Pool;
  readonly #scope = new AsyncLocalStorage<TransactionScope>();
  #tail: Promise<void> = Promise.resolve();

  constructor(url: () => string = () => process.env.DATABASE_URL ?? '') {
    this.#url = url;
    // The tables the Architecture keeps: the outbox (ADR 24) and the bus's inbox.
    this.prepare(async database => {
      await database.exec(
        'CREATE TABLE IF NOT EXISTS outbox (seq BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, payload TEXT NOT NULL)',
      );
      await database.exec(
        'CREATE TABLE IF NOT EXISTS inbox (subscriber TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (subscriber, message_id))',
      );
    });
  }

  /** Runs `setup` once, when the database is prepared: a table, an index, a column. Schema steps run in order. */
  prepare(setup: Setup): void {
    this.#setups.push(setup);
  }

  /** Runs `step` once, when the database is prepared and after anything moved into it: a row the application needs. */
  seed(step: Setup): void {
    this.#seeds.push(step);
  }

  get setups(): readonly Setup[] {
    return this.#setups;
  }

  get seeds(): readonly Setup[] {
    return this.#seeds;
  }

  /** The pool of connections, opened on first use. */
  get pool(): pg.Pool {
    if (!this.#pool) {
      const connectionString = this.#url();
      if (!connectionString)
        throw new Error('DATABASE_URL is not set: name the PostgreSQL database Tally keeps its state in');
      this.#pool = new Pool({ connectionString, max: 10 });
    }
    return this.#pool;
  }

  /** Waits for the process's turn. Resolves to the function that gives it back. */
  acquire(): Promise<() => void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>(resolve => (release = resolve));
    return previous.then(() => release);
  }

  /**
   * Runs `operation` alone in the process: the one read or statement that is not in a unit's transaction. Inside a
   * transaction already, the flow holds the turn: the read runs on the transaction's connection, at once.
   */
  async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.inTransaction) return operation();
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Whether the flow of the caller is in a transaction: a store read or written there uses the transaction's connection. */
  get inTransaction(): boolean {
    return this.#scope.getStore()?.client !== undefined;
  }

  /** A store is used inside a transaction only: a read or a write outside one would not be isolated. */
  assertInTransaction(): void {
    if (!this.inTransaction) {
      throw new Error(
        'A store is used inside a transaction only: the use case that reads or writes it must run in one',
      );
    }
  }

  /**
   * Binds a transaction's scope to the caller's async flow. Called synchronously, before the caller's first `await`, so
   * that every continuation of the flow inherits it; the transaction opens later, into the scope it returned.
   */
  beginScope(): TransactionScope {
    const scope: TransactionScope = {};
    this.#scope.enterWith(scope);
    return scope;
  }

  /**
   * Opens the transaction into `scope`: a connection of its own, `BEGIN`, and the advisory lock that serialises writers
   * across processes. The caller holds the process's turn.
   */
  async openTransaction(scope: TransactionScope): Promise<void> {
    if (scope.client) throw new Error('Transaction already in progress');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [TALLY_LOCK]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release(true);
      throw error;
    }
    scope.client = client;
  }

  /** Commits the open transaction. A failed COMMIT leaves it open: the caller rolls it back, and that ends it. */
  async commitOpenTransaction(scope: TransactionScope): Promise<void> {
    if (!scope.client) throw new Error('No active transaction to commit');
    await scope.client.query('COMMIT');
    this.#endOpenTransaction(scope, false);
  }

  /** Undoes the open transaction, every write of it, and ends it. */
  async rollbackOpenTransaction(scope: TransactionScope): Promise<void> {
    if (!scope.client) throw new Error('No active transaction to rollback');
    await scope.client.query('ROLLBACK').catch(() => undefined);
    this.#endOpenTransaction(scope, false);
  }

  #endOpenTransaction(scope: TransactionScope, broken: boolean): void {
    const client = scope.client;
    scope.client = undefined;
    client?.release(broken);
  }

  /**
   * Runs `work` in one transaction of its own, under the turn, and commits it when `work` returns; a throw rolls it
   * back and rethrows. Used by the Bootstrap, which prepares the database and moves a file into it in one step.
   */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const scope = this.beginScope();
    const release = await this.acquire();
    try {
      await this.openTransaction(scope);
      let value: T;
      try {
        value = await work();
        await this.commitOpenTransaction(scope);
      } catch (error) {
        await this.rollbackOpenTransaction(scope);
        throw error;
      }
      return value;
    } finally {
      release();
    }
  }

  /** The statement's rows, on the transaction's connection when the flow is in one, on the pool otherwise. */
  async all<R extends Row = Row>(sql: string, params: unknown[] = []): Promise<R[]> {
    const { rows } = await this.query<R>(sql, params);
    return rows;
  }

  /** The first row of the statement's rows, if there is one. */
  async get<R extends Row = Row>(sql: string, params: unknown[] = []): Promise<R | undefined> {
    const { rows } = await this.query<R>(sql, params);
    return rows[0];
  }

  /** Runs a statement that writes; `changes` is how many rows it touched, as SQLite counted them. */
  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const { rowCount } = await this.query(sql, params);
    return { changes: rowCount ?? 0 };
  }

  /** Runs one or more statements with no parameters: a schema step. */
  async exec(sql: string): Promise<void> {
    await this.#connection().query(sql);
  }

  /**
   * A statement on a connection of its own, outside the process's turn and any transaction: for what is durable on its
   * own, whose answer does not depend on a unit of work (the bus's inbox). It must not wait for the turn, which the
   * caller may itself hold.
   */
  async pooled<R extends Row = Row>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(positional(sql), params);
  }

  /** The transaction's connection when the flow is in one, the pool otherwise. */
  #connection(): pg.Pool | pg.PoolClient {
    return this.#scope.getStore()?.client ?? this.pool;
  }

  async query<R extends Row = Row>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    return this.#connection().query<R>(positional(sql), params);
  }

  /** Closes the pool: the server's last step, and a test's. */
  async close(): Promise<void> {
    await this.#pool?.end();
    this.#pool = undefined;
  }
}

/** The application's database: every unit of work of the process writes to this database. */
export const sharedDatabase = new PostgresDatabase();
