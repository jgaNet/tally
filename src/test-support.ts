import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, Application } from './app';

/** A directory of its own, for one test's database file, removed by `remove`. */
export function temporaryDatabase(): { path: string; remove(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'tally-test-'));
  return { path: join(directory, 'tally.db'), remove: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Starts an application on a random port, on the database file at `databasePath`. */
export async function startApplication(databasePath: string): Promise<Application> {
  const app = await createApplication({ databasePath });
  await app.start(0);
  return app;
}

/** Where an application answers: what `call` needs of it. */
export type Reachable = Pick<Application, 'address' | 'apiPrefix'>;

export interface Answer {
  status: number;
  // Response bodies are JSON read by the tests, whose assertions say what each one holds.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** One request to the application; a JSON `body` is sent as JSON, a `token` as the bearer token. */
export async function call(
  app: Reachable,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  { body, token, raw }: { body?: unknown; token?: string; raw?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${app.address}/${app.apiPrefix}${path}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

export const ada = { email: 'ada@example.com', password: 'analytical-engine', name: 'Ada Lovelace' };
