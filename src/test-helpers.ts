import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createApplication, type Application } from './app';

/**
 * What one test keeps: a PostgreSQL database of its own, on the server `DATABASE_URL` names, and a directory with a path
 * for the SQLite file a test may write (a file Tally kept before PostgreSQL, see `openDatabase`).
 */
export interface TestDirectory {
  /** The URL of the test's database. It is created when an application first opens it. */
  readonly databaseUrl: string;
  /** The path of a SQLite file, which the test writes when it needs one. */
  readonly legacyPath: string;
  /** Drops the test's database and removes its directory. */
  remove(): Promise<void>;
}

/** The URL of the server the tests run on: `DATABASE_URL`, whose database the tests never use. */
function serverUrl(): URL {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the PostgreSQL server the tests run on.');
  return new URL(url);
}

/** The name of the database a URL names. */
function databaseNameOf(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
}

/** Runs `work` on a connection to the server's `postgres` database, which creates and drops the tests' databases. */
async function onServer<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = serverUrl();
  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** A directory of its own for one test, and a database of its own on the server, both named by one random id. */
export function testDirectory(): TestDirectory {
  const name = `tally_test_${randomUUID().replaceAll('-', '')}`;
  const url = serverUrl();
  url.pathname = `/${name}`;
  const directory = mkdtempSync(join(tmpdir(), 'tally-test-'));
  return {
    databaseUrl: url.toString(),
    legacyPath: join(directory, 'tally.db'),
    async remove() {
      await onServer(client => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Creates the database `databaseUrl` names on the server, unless it exists already. */
export async function ensureDatabase(databaseUrl: string): Promise<void> {
  const name = databaseNameOf(databaseUrl);
  await onServer(async client => {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${name}"`);
  });
}

/** Starts an application on a free port over the database at `databaseUrl`, creating the database first. */
export async function startApplication(
  databaseUrl: string,
  options: { databasePath?: string } = {},
): Promise<Application> {
  await ensureDatabase(databaseUrl);
  const app = await createApplication({ databaseUrl, databasePath: options.databasePath ?? '' });
  await app.start(0);
  return app;
}

export interface Reply {
  status: number;
  body: unknown;
}

/** Sends a JSON request to the application's API, with `token` as its bearer token when given. */
export async function send(
  app: Application,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: { body?: unknown; token?: string; authorization?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${app.address}/${app.apiPrefix}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

/** Signs up an account and signs it in, answering the account's id and token. */
export async function signedUpAccount(
  app: Application,
  fields: { email: string; password?: string; name?: string },
): Promise<{ id: string; token: string }> {
  const password = fields.password ?? 'correct horse';
  const signUp = await send(app, 'POST', '/accounts', {
    body: { email: fields.email, password, name: fields.name ?? 'Ana' },
  });
  if (signUp.status !== 201) throw new Error(`sign-up answered ${signUp.status}`);
  const logIn = await send(app, 'POST', '/accounts/login', { body: { email: fields.email, password } });
  if (logIn.status !== 200) throw new Error(`log-in answered ${logIn.status}`);
  return { id: (signUp.body as { id: string }).id, token: (logIn.body as { token: string }).token };
}
