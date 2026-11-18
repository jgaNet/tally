import pg from 'pg';

// A BIGINT (a COUNT, a SUM of INTEGERs, a BIGSERIAL) and a NUMERIC (a SUM of BIGINTs) are read as numbers, as the
// SQLite file gave them: every amount the application keeps is an integer of hundredths, far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);

/** What the migrations and the move take, so that two servers starting on one database do it one after the other. */
const SCHEMA_LOCK = 7_243_001;
/** What every write transaction takes, so that two servers' transactions are one after the other (ADR 22). */
const WRITE_LOCK = 7_243_002;

/**
 * A connection, as a store speaks to it: statements are written with `?` placeholders, numbered in order (`$1`, `$2`,
 * …) when they are sent; a `?` inside a quoted literal is left as it is.
 */
export interface Connection {
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  row<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  /** Runs a statement and says how many rows it changed. */
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
}

/**
 * The application's one PostgreSQL database: the one `DATABASE_URL` names (ADR 22).
 *
 * One connection per process, and several processes may use the same database. Within a process
 * a transaction holds the connection, so whatever else would be written meanwhile waits for it:
 * `exclusive()` and the unit of work take one turn at a time, in the order they asked. Between
 * processes, every write transaction takes one advisory lock first, so the second one waits for
 * the first to commit and then reads what it left — the order the SQLite file's lock gave (ADR 2).
 *
 * Rules for the code that uses it (unchanged from ADR 2):
 * - a repository, inside a command's transaction, uses `connection` directly: the transaction
 *   already holds the turn;
 * - anything that is not in a transaction (a query, a record written on the side, the outbox's
 *   bookkeeping) goes through `exclusive()`, which waits for the transaction in progress.
 */
export class PostgresDatabase {
  static #shared?: PostgresDatabase;

  /** The process's database, from `DATABASE_URL` (under test, a database of the test file's own: jest.setup.js). */
  static shared(): PostgresDatabase {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL names no PostgreSQL database');
    return (PostgresDatabase.#shared ??= new PostgresDatabase(url));
  }

  readonly #pool: pg.Pool;
  #ready: Promise<void>;
  #held: pg.PoolClient | null = null;
  #closed = false;
  /** Every statement `migrate()` was given, in order: the move runs them again over what it moved. */
  readonly #statements: string[] = [];

  constructor(readonly url: string) {
    this.#pool = new pg.Pool({ connectionString: url, max: 1, idleTimeoutMillis: 1000, allowExitOnIdle: true });
    // A connection the server closed while idle is dropped by the pool; the next turn opens another.
    this.#pool.on('error', () => undefined);
    this.#ready = createIfMissing(url);
  }

  /**
   * Creates what a store needs, idempotently (`CREATE … IF NOT EXISTS`, `ON CONFLICT DO NOTHING`), before anything
   * else reads or writes: the statements run in order, under the schema lock, in a transaction of their own.
   */
  migrate(statements: string[]): void {
    this.#statements.push(...statements);
    this.#ready = this.#ready.then(() => this.underSchemaLock(connection => runAll(connection, statements)));
  }

  /** Resolves once every migration given so far has run. */
  async ready(): Promise<void> {
    await this.#ready;
  }

  /**
   * Runs `fn` in a transaction of its own that holds the schema lock: what two servers starting at once prepare is
   * prepared once, the second finding it done. Not a turn of the process: the migrations and the move come before.
   */
  async underSchemaLock<T>(fn: (connection: Connection, statements: readonly string[]) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
      const result = await fn(wrap(client), this.#statements);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The connection of the turn in progress: a repository inside a command's transaction uses it. */
  get connection(): Connection {
    if (!this.#held) throw new Error('No turn is held on the database: use exclusive() outside a transaction');
    return wrap(this.#held);
  }

  /** Waits for its turn on the connection; the function it returns gives the turn back. */
  async acquire(): Promise<() => void> {
    await this.#ready;
    const client = await this.#pool.connect();
    this.#held = client;
    return () => {
      if (this.#held === client) this.#held = null;
      client.release();
    };
  }

  /** Begins a write transaction on the turn held: after the lock every write transaction takes (ADR 22). */
  async begin(): Promise<void> {
    await this.connection.run('BEGIN');
    await this.connection.run('SELECT pg_advisory_xact_lock(?)', WRITE_LOCK);
  }

  /** Runs `fn` on the connection outside any other transaction of this process. */
  async exclusive<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn(this.connection);
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#ready.catch(() => undefined);
    await this.#pool.end();
  }
}

async function runAll(connection: Connection, statements: readonly string[]): Promise<void> {
  for (const statement of statements) await connection.run(statement);
}

function wrap(client: pg.PoolClient): Connection {
  return {
    async rows<T>(sql: string, ...params: unknown[]) {
      return (await client.query(numbered(sql), params)).rows as T[];
    },
    async row<T>(sql: string, ...params: unknown[]) {
      return (await client.query(numbered(sql), params)).rows[0] as T | undefined;
    },
    async run(sql: string, ...params: unknown[]) {
      return { changes: (await client.query(numbered(sql), params)).rowCount ?? 0 };
    },
  };
}

/** `?` → `$1`, `$2`, …, outside quoted literals and identifiers. */
export function numbered(sql: string): string {
  let n = 0;
  let quote: string | null = null;
  let out = '';
  for (const char of sql) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '?') {
      out += `$${++n}`;
      continue;
    }
    out += char;
  }
  return out;
}

/** The database `url` names, created on its server when it does not exist yet (a test file's own, a first start). */
async function createIfMissing(url: string): Promise<void> {
  const probe = new pg.Client({ connectionString: url });
  try {
    await probe.connect();
    return;
  } catch (error) {
    if ((error as { code?: string }).code !== '3D000') throw error;
  } finally {
    await probe.end().catch(() => undefined);
  }
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  target.pathname = '/postgres';
  const server = new pg.Client({ connectionString: target.toString() });
  await server.connect();
  try {
    await server.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } catch (error) {
    // Another process created it in the meantime.
    if (!['42P04', '23505'].includes((error as { code?: string }).code ?? '')) throw error;
  } finally {
    await server.end();
  }
}
