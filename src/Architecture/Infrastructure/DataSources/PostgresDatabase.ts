import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * The transaction an async chain runs in: once a client is set, every query of the chain runs on it. A unit of work or a
 * transaction of a repository makes one; the chain that enters it keeps it until it is left.
 */
export interface TransactionScope {
  client?: PoolClient;
}

const scopes = new AsyncLocalStorage<TransactionScope>();

/** The URL of the database Tally keeps its state in (`DATABASE_URL`), read when it is needed, so that a process may set it before then. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set: Tally keeps its state in the PostgreSQL database it names');
  return url;
}

/**
 * The advisory lock every write transaction takes: writers take turns across the servers on one database, as `BEGIN IMMEDIATE`
 * made them take turns on one SQLite file (ADR 17). Reads take no lock: they read what is committed.
 */
const WRITERS_LOCK = 7410001;

/**
 * One PostgreSQL database of the process, reached through one pool, named by its URL (`DATABASE_URL`). Its writes are
 * transactions that take turns; a transaction begun inside another one on the same database, in the same async chain, joins it,
 * so a repository's write is the same transaction as the use case that decided it. A transaction whose work throws rolls back what
 * it wrote. Outside any transaction a query runs on its own, on a pooled connection.
 */
export class PostgresDatabase {
  static readonly #databases = new Map<string, PostgresDatabase>();
  readonly #pool: Pool;

  private constructor(readonly url: string) {
    this.#pool = new Pool({ connectionString: url, max: 10 });
  }

  /** The database at `url`, the same object for the same URL, whichever context names it. */
  static of(url: string): PostgresDatabase {
    const existing = PostgresDatabase.#databases.get(url);
    if (existing) return existing;
    const database = new PostgresDatabase(url);
    PostgresDatabase.#databases.set(url, database);
    return database;
  }

  /** Closes every pool the process opened: the application's stop, and the end of a test. */
  static async closeAll(): Promise<void> {
    const databases = [...PostgresDatabase.#databases.values()];
    PostgresDatabase.#databases.clear();
    await Promise.all(databases.map(database => database.#pool.end()));
  }

  /** Makes `scope` the transaction of the async chain that calls this, from here on. */
  static enterScope(scope: TransactionScope): void {
    scopes.enterWith(scope);
  }

  /** Runs a query on the transaction of the chain when one is open, on the pool otherwise. */
  async query<R extends QueryResultRow = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const client = scopes.getStore()?.client;
    return client ? client.query<R>(text, params) : this.#pool.query<R>(text, params);
  }

  /**
   * Runs `work` in a transaction on the database: committed when it resolves, rolled back and re-thrown when it throws. Inside a
   * transaction already open in this chain, it runs inside that one. Otherwise it takes the writers' lock, then begins.
   */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (scopes.getStore()?.client) return work();
    const scope: TransactionScope = {};
    await this.openScope(scope);
    try {
      const result = await scopes.run(scope, work);
      await this.closeScope(scope, 'commit');
      return result;
    } catch (error) {
      await this.closeScope(scope, 'rollback').catch(() => undefined);
      throw error;
    }
  }

  /** Connects, begins and takes the writers' lock, for `scope`, which the caller has entered. */
  async openScope(scope: TransactionScope): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITERS_LOCK]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      throw error;
    }
    scope.client = client;
  }

  /** Commits or rolls back the transaction of `scope`, and gives its connection back to the pool. */
  async closeScope(scope: TransactionScope, outcome: 'commit' | 'rollback'): Promise<void> {
    const client = scope.client;
    if (!client) return;
    scope.client = undefined;
    try {
      await client.query(outcome === 'commit' ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Runs `statements` once the tables they make exist, in a transaction under the writers' lock: idempotent, and safe for two servers. */
  setUp(statements: (database: PostgresDatabase) => Promise<void>): Promise<void> {
    return this.transaction(() => statements(this));
  }
}

/**
 * The tables one context keeps in the database: made once, before its first use, by `setUp` (idempotent, with what an older
 * layout needs), and reached through the one database of the process. A context's repositories read and write through it.
 */
export class PostgresTables {
  #ready?: Promise<void>;

  constructor(
    private readonly urlOf: () => string,
    private readonly setUp: (database: PostgresDatabase) => Promise<void>,
    /** Fills rows a file that is moved in may leave out (DML only: it runs once that move is through, see `settle`). */
    private readonly backfill: (database: PostgresDatabase) => Promise<void> = async () => undefined,
  ) {}

  /** The database the tables are in. */
  get database(): PostgresDatabase {
    return PostgresDatabase.of(this.urlOf());
  }

  /** Makes the tables, once per process; a set-up that fails is tried again by the next use. */
  ready(): Promise<void> {
    this.#ready ??= this.database.setUp(this.setUp).catch(error => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  /** Runs the tables' backfill now, once a moved file's rows are in (idempotent). */
  async settle(): Promise<void> {
    await this.database.setUp(this.backfill);
  }

  /** The rows a query answers. */
  async rows<R extends QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> {
    await this.ready();
    return (await this.database.query<R>(text, params)).rows;
  }

  /** The rows a query answers, the first one or none. */
  async row<R extends QueryResultRow = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<R | undefined> {
    return (await this.rows<R>(text, params))[0];
  }

  /** How many rows a statement changed. */
  async execute(text: string, params: unknown[] = []): Promise<number> {
    await this.ready();
    return (await this.database.query(text, params)).rowCount ?? 0;
  }

  /** Runs `work` in a transaction on the tables' database (see `PostgresDatabase.transaction`). */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    await this.ready();
    return this.database.transaction(work);
  }
}
