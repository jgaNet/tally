import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, type Application } from './app';

/** A directory of its own for a test's database file, removed by `remove`. */
export interface TestDirectory {
  readonly databasePath: string;
  remove(): void;
}

export function testDirectory(): TestDirectory {
  const directory = mkdtempSync(join(tmpdir(), 'tally-test-'));
  return {
    databasePath: join(directory, 'tally.db'),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Starts an application on a free port over the database file at `databasePath`. */
export async function startApplication(databasePath: string): Promise<Application> {
  const app = await createApplication({ databasePath });
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
  method: 'GET' | 'POST',
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
