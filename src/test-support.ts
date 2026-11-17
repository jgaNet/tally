import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application } from './app';

/** A database file no other test shares. */
export function temporaryDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tally-test-')), 'tally.db');
}

/** Sends a request to the application without a socket: `/v1` plus `path`. */
export function send(
  app: Application,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: { token?: string; payload?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  return app.server.inject({
    method,
    url: `/${app.apiPrefix}${path}`,
    headers,
    payload: options.payload as object | undefined,
  });
}

export const validSignup = {
  email: 'ada@example.com',
  password: 'correct horse',
  name: 'Ada',
};

/**
 * Makes the account of `joinerToken` a member of `groupId`, through an invitation that the member
 * `inviterToken` creates and the joiner accepts.
 */
export async function joinThroughInvitation(
  app: Application,
  inviterToken: string,
  joinerToken: string,
  groupId: string,
): Promise<void> {
  const created = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: inviterToken });
  if (created.statusCode !== 201) {
    throw new Error(`invitation failed: ${created.statusCode} ${created.body}`);
  }
  const accepted = await send(app, 'POST', `/invitations/${created.json<{ id: string }>().id}/accept`, {
    token: joinerToken,
  });
  if (accepted.statusCode !== 201) {
    throw new Error(`joining failed: ${accepted.statusCode} ${accepted.body}`);
  }
}

/** Signs an account up and in; returns its id and token. */
export async function signedUpAccount(app: Application, overrides: Partial<typeof validSignup> = {}) {
  const body = { ...validSignup, ...overrides };
  const created = await send(app, 'POST', '/accounts', { payload: body });
  if (created.statusCode !== 201) {
    throw new Error(`sign-up failed: ${created.statusCode} ${created.body}`);
  }
  const login = await send(app, 'POST', '/accounts/login', {
    payload: { email: body.email, password: body.password },
  });
  return { id: created.json<{ id: string }>().id, token: login.json<{ token: string }>().token };
}
