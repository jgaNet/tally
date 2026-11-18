import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The accounts over HTTP, against a database file: the API's answers (fragment 2), each refusal's status, the sign-in's
 * one answer for a wrong password and an unknown email, and what a restart and a second server on the same file find.
 */
let directory: string;
let databaseUrl: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const ann = { email: 'ann@example.com', password: 'a long enough password', name: 'Ann' };

const start = async (path = databaseUrl) => {
  const started = await createApplication({ databaseUrl: path, logger: silent });
  await started.start(0);
  return started;
};
const silent = { info() {}, warn() {}, error() {}, debug() {} };

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-accounts-'));
  databaseUrl = await freshDatabase();
  app = await start();
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

const signUp = (body: unknown) => http.request('POST', `${api}/accounts`, { body });
const login = (body: unknown) => http.request('POST', `${api}/accounts/login`, { body });
const me = (token?: string) => http.request('GET', `${api}/accounts/me`, { token });

describe('signing up', () => {
  it('creates the account and answers its id', async () => {
    const { status, body } = await signUp(ann);
    expect(status).toBe(201);
    expect(body).toEqual({ id: expect.any(String) });
  });

  it('refuses an email an account already uses, whatever its case, with a conflict', async () => {
    const { status, body } = await signUp({ ...ann, email: 'ANN@example.com' });
    expect(status).toBe(409);
    expect(body).toEqual({ type: 'EmailAlreadyRegistered', message: 'An account already uses this email' });
  });

  it.each([
    ['an email that does not look like one', { ...ann, email: 'ann-at-example' }, 'InvalidEmailFormat'],
    ['a password under 8 characters', { ...ann, email: 'short@example.com', password: 'short' }, 'WeakPassword'],
    ['a name that is only spaces', { ...ann, email: 'blank@example.com', name: '   ' }, 'InvalidName'],
    ['a name over 60 characters', { ...ann, email: 'long@example.com', name: 'x'.repeat(61) }, 'InvalidName'],
  ])('refuses %s with the rule that refused it', async (_, body, type) => {
    const { status, body: answer } = await signUp(body);
    expect(status).toBe(422);
    expect(answer).toMatchObject({ type });
  });

  it('answers a body missing a field with 400, before any rule is asked', async () => {
    expect((await signUp({ email: 'x@example.com', password: 'a long enough password' })).status).toBe(400);
    expect((await signUp({ ...ann, name: 7 })).status).toBe(400);
  });
});

describe('signing in', () => {
  it('answers a token for the right password', async () => {
    const { status, body } = await login({ email: ann.email, password: ann.password });
    expect(status).toBe(200);
    expect(body).toEqual({ token: expect.any(String) });
  });

  it('refuses a wrong password and an unknown email with the same answer, 401', async () => {
    const wrong = await login({ email: ann.email, password: 'not the password' });
    const unknown = await login({ email: 'nobody@example.com', password: ann.password });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.body).toEqual({ type: 'InvalidCredentials', message: 'The email or the password is wrong' });
  });
});

describe('reading one’s own account', () => {
  it('answers the signed-in person’s account', async () => {
    const { token } = (await login({ email: ann.email, password: ann.password })).body as { token: string };
    const { status, body } = await me(token);
    expect(status).toBe(200);
    expect(body).toEqual({ id: expect.any(String), email: ann.email, name: ann.name });
  });

  it('refuses a request with no token, or a token that proves nothing, with 401', async () => {
    expect((await me()).status).toBe(401);
    expect((await me('not-a-token')).status).toBe(401);
  });
});

describe('the database a server keeps', () => {
  it('finds the accounts and the tokens of a stopped server, started again on the same file', async () => {
    const token = (await login({ email: ann.email, password: ann.password })).body as { token: string };
    await app.stop();

    app = await start();
    http = apiClient(app.address);
    expect((await me(token.token)).status).toBe(200);
    expect((await login({ email: ann.email, password: ann.password })).status).toBe(200);
  });

  it('shares the file with a second server running at the same time', async () => {
    const other = await start();
    try {
      const otherHttp = apiClient(other.address);
      await otherHttp.request('POST', `${api}/accounts`, {
        body: { email: 'bob@example.com', password: 'a long enough password', name: 'Bob' },
      });
      const login = await otherHttp.request('POST', `${api}/accounts/login`, {
        body: { email: 'bob@example.com', password: 'a long enough password' },
      });
      const token = (login.body as { token: string }).token;

      expect((await me(token)).body).toMatchObject({ email: 'bob@example.com', name: 'Bob' });
      expect(
        (
          await otherHttp.request('POST', `${api}/accounts`, {
            body: { email: 'BOB@example.com', password: 'a long enough password', name: 'Bob' },
          })
        ).status,
      ).toBe(409);
    } finally {
      await other.stop();
    }
  });
});
