import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The groups over HTTP, against a database file: the API's answers (fragment 3), who sees a group and who does not, the
 * order of the list, each refusal's status, and what a restart finds.
 */
let directory: string;
let databasePath: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const start = async (path = databasePath) => {
  const started = await createApplication({ databasePath: path, logger: silent });
  await started.start(0);
  return started;
};

const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-groups-'));
  databasePath = join(directory, 'tally.sqlite');
  app = await start();
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
});
afterAll(async () => {
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

/** A signed-in person: their token, and their account id as the account answers it. */
async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;
const createGroup = (token: string | undefined, body: unknown) =>
  http.request('POST', `${api}/groups`, { token, body });

describe('creating a group', () => {
  it('creates it for the signed-in person and answers its id', async () => {
    const { status, body } = await createGroup(ann.token, { name: 'Flat', currency: 'EUR' });
    expect(status).toBe(201);
    expect(body).toEqual({ id: expect.any(String) });
  });

  it('refuses a name of only spaces, or over 60 characters, with the rule that refused it', async () => {
    expect(await createGroup(ann.token, { name: '   ', currency: 'EUR' })).toMatchObject({
      status: 422,
      body: { type: 'InvalidGroupName' },
    });
    expect(await createGroup(ann.token, { name: 'x'.repeat(61), currency: 'EUR' })).toMatchObject({
      status: 422,
      body: { type: 'InvalidGroupName' },
    });
  });

  it('refuses a currency outside the six, whatever its case', async () => {
    expect(await createGroup(ann.token, { name: 'Flat', currency: 'JPY' })).toMatchObject({
      status: 422,
      body: { type: 'UnsupportedCurrency' },
    });
    expect(await createGroup(ann.token, { name: 'Flat', currency: 'eur' })).toMatchObject({ status: 422 });
  });

  it('answers a body of the wrong shape with 400, before any rule is asked', async () => {
    expect((await createGroup(ann.token, { name: 'Flat' })).status).toBe(400);
    expect((await createGroup(ann.token, { name: 'Flat', currency: 978 })).status).toBe(400);
  });

  it('refuses a request with no signed-in person with 401', async () => {
    expect((await createGroup(undefined, { name: 'Flat', currency: 'EUR' })).status).toBe(401);
  });
});

describe('reading a group', () => {
  it('answers the group to its owner, who is its first member', async () => {
    const { body: created } = await createGroup(ann.token, { name: 'Lisbon', currency: 'GBP' });
    const id = (created as { id: string }).id;

    const { status, body } = await http.request('GET', `${api}/groups/${id}`, { token: ann.token });
    expect(status).toBe(200);
    expect(body).toEqual({ id, name: 'Lisbon', currency: 'GBP', ownerId: ann.id });
  });

  it('answers a group that is someone else’s with the same 404 as one that does not exist', async () => {
    const { body: created } = await createGroup(ann.token, { name: 'Secret', currency: 'CHF' });
    const id = (created as { id: string }).id;

    const stranger = await http.request('GET', `${api}/groups/${id}`, { token: bob.token });
    const missing = await http.request('GET', `${api}/groups/no-such-group`, { token: bob.token });
    expect(stranger.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
    expect(stranger.body).toMatchObject({ type: 'NotFound' });
  });

  it('refuses a request with no signed-in person with 401', async () => {
    expect((await http.request('GET', `${api}/groups/anything`)).status).toBe(401);
  });
});

describe('listing my groups', () => {
  it('lists the groups I am a member of, the most recently created first, and no one else’s', async () => {
    const carol = await person('Carol', 'carol@example.com');
    const first = (await createGroup(carol.token, { name: 'Climbing club', currency: 'AUD' })).body as { id: string };
    const second = (await createGroup(carol.token, { name: 'Trip', currency: 'USD' })).body as { id: string };
    await createGroup(bob.token, { name: 'Not Carol’s', currency: 'EUR' });

    const { status, body } = await http.request('GET', `${api}/groups/mine`, { token: carol.token });
    expect(status).toBe(200);
    expect(body).toEqual([
      { id: second.id, name: 'Trip', currency: 'USD', ownerId: carol.id },
      { id: first.id, name: 'Climbing club', currency: 'AUD', ownerId: carol.id },
    ]);
  });

  it('answers an empty list to a person in no group', async () => {
    const dave = await person('Dave', 'dave@example.com');
    const { status, body } = await http.request('GET', `${api}/groups/mine`, { token: dave.token });
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('refuses a request with no signed-in person with 401', async () => {
    expect((await http.request('GET', `${api}/groups/mine`)).status).toBe(401);
  });
});

describe('the database a server keeps', () => {
  it('finds the groups of a stopped server, started again on the same file', async () => {
    const { body: created } = await createGroup(ann.token, { name: 'Kept', currency: 'CAD' });
    const id = (created as { id: string }).id;
    await app.stop();

    app = await start();
    http = apiClient(app.address);
    const { body } = await http.request('GET', `${api}/groups/${id}`, { token: ann.token });
    expect(body).toMatchObject({ id, name: 'Kept', currency: 'CAD', ownerId: ann.id });
  });
});
