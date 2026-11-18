import { Client, types } from 'pg';

// A count or a sum comes back as a number, as it did from the file this replaces (ADR 30).
types.setTypeParser(20, Number);
types.setTypeParser(1700, Number);

export type SqlValue = string | number | boolean | null;

/** What the move from the file does while the database is being prepared: it is handed the database, inside its transaction. */
export type FirstUse = (database: PostgresDatabase) => Promise<void>;

/**
 * The one PostgreSQL database an application keeps what it knows in (`DATABASE_URL`, ADR 30), opened once per process.
 *
 * Several servers may run on the same database. Inside a process, one connection is shared by every request, and `lock()`
 * is what keeps one request's transaction from containing another's writes: whoever works outside a transaction of its own
 * goes through `exclusive()`. Between servers, a transaction takes one advisory lock of the database as it begins, so the
 * writers queue as they did on a file, and a server that dies releases it with its connection.
 *
 * The tables are declared (`declare`) by whoever needs them and made, once, by `prepare()` — under that same lock, so that
 * two servers started on an empty database make them once, and so that the move from a file (`FirstUse`) is done by one of
 * them while the other waits and finds it done.
 */
export class PostgresDatabase {
  readonly #client: Client;
  readonly #connected: Promise<unknown>;
  readonly #declared: string[] = [];
  readonly #settings = new Map<string, { create: () => string; value?: string }>();
  #applied = 0;
  #prepared: Promise<void> | null = null;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly url: string,
    readonly schema?: string,
  ) {
    this.#client = new Client({
      connectionString: url,
      ...(schema && { options: `-c search_path=${schema}` }),
    });
    this.#client.on('error', () => undefined);
    this.#connected = this.#client.connect();
    this.#connected.catch(() => undefined);
  }

  /** Says a table or an index is needed. Nothing runs until `prepare()`; saying it twice is saying it once. */
  declare(sql: string): void {
    const statement = sql
      .replace(/\bINTEGER\b/g, 'BIGINT')
      .replace(/\bTEXT\b(?! COLLATE)/g, 'TEXT COLLATE "C"')
      .trim();
    if (!this.#declared.includes(statement)) this.#declared.push(statement);
  }

  /** One statement, as it is; the caller holds the lock, or is the transaction. */
  async query<Row = Record<string, unknown>>(
    sql: string,
    ...parameters: SqlValue[]
  ): Promise<{ rows: Row[]; count: number }> {
    await this.#connected;
    const result = await this.#client.query(placeholders(sql), parameters);
    return { rows: result.rows as Row[], count: result.rowCount ?? 0 };
  }

  /** One write; says how many rows it changed. */
  async run(sql: string, ...parameters: SqlValue[]): Promise<number> {
    return (await this.query(sql, ...parameters)).count;
  }

  async get<Row>(sql: string, ...parameters: SqlValue[]): Promise<Row | undefined> {
    return (await this.query<Row>(sql, ...parameters)).rows[0];
  }

  async all<Row>(sql: string, ...parameters: SqlValue[]): Promise<Row[]> {
    return (await this.query<Row>(sql, ...parameters)).rows;
  }

  /**
   * A value this database keeps once for everyone who uses it (a signing secret): the first server to prepare makes it,
   * and every other, at the same time or later, reads that one. It is read once the database is prepared.
   */
  setting(key: string, create: () => string): () => string {
    const entry = this.#settings.get(key) ?? { create };
    this.#settings.set(key, entry);
    return () => {
      if (entry.value === undefined) throw new Error('The database is not prepared');
      return entry.value;
    };
  }

  /**
   * Makes what was declared, once for everyone who uses the database, and says nothing is left to do before serving.
   * `firstUse` runs, in the same transaction, only on a database that held nothing of the application's.
   */
  prepare(firstUse?: FirstUse): Promise<void> {
    this.#prepared ??= this.#prepare(firstUse).catch(error => {
      this.#prepared = null;
      throw error;
    });
    return this.#prepared;
  }

  async #prepare(firstUse?: FirstUse): Promise<void> {
    await this.#connected;
    await this.#client.query('BEGIN');
    try {
      await this.lockWrites();
      if (this.schema) await this.#client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      const fresh =
        (await this.get<{ there: string | null }>("SELECT to_regclass('tally_meta') AS there"))?.there == null;
      await this.query(
        'CREATE TABLE IF NOT EXISTS settings (key TEXT COLLATE "C" PRIMARY KEY, value TEXT COLLATE "C" NOT NULL)',
      );
      await this.#applyDeclared();
      if (fresh && firstUse) await firstUse(this);
      for (const [key, entry] of this.#settings) {
        await this.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
          key,
          entry.create(),
        );
        entry.value = (await this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key))?.value;
      }
      await this.query(
        'CREATE TABLE IF NOT EXISTS tally_meta (key TEXT COLLATE "C" PRIMARY KEY, value TEXT COLLATE "C" NOT NULL)',
      );
      await this.run("INSERT INTO tally_meta (key, value) VALUES ('prepared', 'yes') ON CONFLICT (key) DO NOTHING");
      await this.#client.query('COMMIT');
    } catch (error) {
      await this.#client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async #applyDeclared(): Promise<void> {
    for (; this.#applied < this.#declared.length; this.#applied++) await this.query(this.#declared[this.#applied]);
  }

  /** The advisory lock of this database's writers, held until the transaction in progress ends. */
  async lockWrites(): Promise<void> {
    await this.query('SELECT pg_advisory_xact_lock(hashtext(?))', `tally:${this.schema ?? 'public'}`);
  }

  /** Waits for the transaction in progress, if any, and holds the connection until the release it answers is called. */
  async lock(): Promise<() => void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>(resolve => (release = resolve));
    await previous;
    try {
      await this.prepare();
      if (this.#applied < this.#declared.length) await this.#applyDeclared();
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  /** Runs a read or a write that has no transaction of its own, after the transaction in progress has ended. */
  async exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const release = await this.lock();
    try {
      return await work();
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    await this.#connected.catch(() => undefined);
    await this.#client.end().catch(() => undefined);
  }
}

/** `?` is the parameter in the statements; PostgreSQL numbers them. A `?` inside a quoted text is text. */
function placeholders(sql: string): string {
  let count = 0;
  let quoted = false;
  let out = '';
  for (const character of sql) {
    if (character === "'") quoted = !quoted;
    out += character === '?' && !quoted ? `$${++count}` : character;
  }
  return out;
}

const opened = new Map<string, PostgresDatabase>();
const everyOpened = ((globalThis as { __tallyDatabases?: Set<PostgresDatabase> }).__tallyDatabases ??= new Set());

/** Closes every database this process opened (the end of a test run). */
export async function closeDatabases(): Promise<void> {
  await Promise.all([...everyOpened].map(database => database.close()));
  everyOpened.clear();
  opened.clear();
}

/**
 * The application's database: the one `DATABASE_URL` names, one connection per process however many modules ask.
 * `DATABASE_SCHEMA`, when set, keeps the tables in a schema of their own (the suites, which run side by side).
 */
export function sharedDatabase(
  url: string | undefined = process.env.DATABASE_URL,
  schema: string | undefined = process.env.DATABASE_SCHEMA,
): PostgresDatabase {
  if (!url) throw new Error('DATABASE_URL names the PostgreSQL database the application keeps its state in');
  const key = `${url}#${schema ?? ''}`;
  let database = opened.get(key);
  if (!database) {
    database = new PostgresDatabase(url, schema);
    opened.set(key, database);
    everyOpened.add(database);
  }
  return database;
}
