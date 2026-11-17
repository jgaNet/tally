import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Invitations and joining over HTTP, against a database file: the API's answers (fragment 4), who may read a link and who
 * may invite, the join once, and the members in the order they joined, with the owner first.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-invitations-'));
  app = await createApplication({ databasePath: join(directory, 'tally.sqlite'), logger: silent });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  carol = await person('Carol', 'carol@example.com');
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
  return { token, id: (me.body as { id: string }).id, name };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;
let carol: Awaited<ReturnType<typeof person>>;

const createGroup = async (name: string) => {
  const { body } = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name, currency: 'EUR' },
  });
  return (body as { id: string }).id;
};
const invite = (token: string | undefined, groupId: string) =>
  http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
const readInvitation = (token: string | undefined, id: string) =>
  http.request('GET', `${api}/invitations/${id}`, { token });
const accept = (token: string | undefined, id: string) =>
  http.request('POST', `${api}/invitations/${id}/accept`, { token });
const members = (token: string | undefined, groupId: string) =>
  http.request('GET', `${api}/groups/${groupId}/members`, { token });

describe('inviting', () => {
  it('lets a member create an invitation, and answers its id', async () => {
    const groupId = await createGroup('Flat');
    const { status, body } = await invite(ann.token, groupId);
    expect(status).toBe(201);
    expect(body).toEqual({ id: expect.any(String) });
  });

  it('answers a group that is not there for the caller with the same 404 as one that does not exist', async () => {
    const groupId = await createGroup('Secret');
    const stranger = await invite(bob.token, groupId);
    const missing = await invite(bob.token, 'no-such-group');
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
  });

  it('refuses a request with no signed-in person with 401', async () => {
    const groupId = await createGroup('Anonymous');
    expect((await invite(undefined, groupId)).status).toBe(401);
  });
});

describe('reading an invitation', () => {
  it('answers the group and who invited to a signed-in person who is not a member', async () => {
    const groupId = await createGroup('Lisbon');
    const { body: created } = await invite(ann.token, groupId);
    const id = (created as { id: string }).id;

    const { status, body } = await readInvitation(bob.token, id);
    expect(status).toBe(200);
    expect(body).toEqual({ id, groupId, groupName: 'Lisbon', invitedBy: ann.id });
  });

  it('answers an invitation that is not there with 404', async () => {
    expect((await readInvitation(bob.token, 'no-such-invitation')).status).toBe(404);
  });

  it('refuses a request with no signed-in person with 401', async () => {
    const groupId = await createGroup('Read');
    const { body } = await invite(ann.token, groupId);
    expect((await readInvitation(undefined, (body as { id: string }).id)).status).toBe(401);
  });
});

describe('joining', () => {
  it('makes the caller a member, and answers nothing', async () => {
    const groupId = await createGroup('Trip');
    const id = ((await invite(ann.token, groupId)).body as { id: string }).id;

    const { status } = await accept(bob.token, id);
    expect(status).toBe(204);
    expect((await members(bob.token, groupId)).status).toBe(200);
  });

  it('refuses a member who joins again with 409, AlreadyMember', async () => {
    const groupId = await createGroup('Again');
    const id = ((await invite(ann.token, groupId)).body as { id: string }).id;
    await accept(bob.token, id);

    expect(await accept(bob.token, id)).toMatchObject({ status: 409, body: { type: 'AlreadyMember' } });
    expect(await accept(ann.token, id)).toMatchObject({ status: 409, body: { type: 'AlreadyMember' } });
  });

  it('answers an invitation that is not there with 404', async () => {
    expect(await accept(bob.token, 'no-such-invitation')).toMatchObject({ status: 404 });
  });

  it('keeps the invitation usable by anyone who holds it', async () => {
    const groupId = await createGroup('Open');
    const id = ((await invite(ann.token, groupId)).body as { id: string }).id;
    expect((await accept(bob.token, id)).status).toBe(204);
    expect((await accept(carol.token, id)).status).toBe(204);
  });

  it('refuses a request with no signed-in person with 401', async () => {
    const groupId = await createGroup('Anon join');
    const id = ((await invite(ann.token, groupId)).body as { id: string }).id;
    expect((await accept(undefined, id)).status).toBe(401);
  });
});

describe('listing the members', () => {
  it('lists them in the order they joined, the owner first, with name, role and when they joined', async () => {
    const groupId = await createGroup('Ordered');
    const id = ((await invite(ann.token, groupId)).body as { id: string }).id;
    await accept(carol.token, id);
    await accept(bob.token, id);

    const { status, body } = await members(ann.token, groupId);
    expect(status).toBe(200);
    expect(body).toEqual([
      { memberId: ann.id, name: 'Ann', role: 'owner', joinedAt: expect.any(String) },
      { memberId: carol.id, name: 'Carol', role: 'member', joinedAt: expect.any(String) },
      { memberId: bob.id, name: 'Bob', role: 'member', joinedAt: expect.any(String) },
    ]);
    const joined = (body as { joinedAt: string }[]).map(member => Date.parse(member.joinedAt));
    expect(joined).toEqual([...joined].sort((a, b) => a - b));
  });

  it('answers a group that is not there for the caller with 404', async () => {
    const groupId = await createGroup('Private');
    expect((await members(bob.token, groupId)).status).toBe(404);
  });

  it('refuses a request with no signed-in person with 401', async () => {
    const groupId = await createGroup('Anon members');
    expect((await members(undefined, groupId)).status).toBe(401);
  });
});
