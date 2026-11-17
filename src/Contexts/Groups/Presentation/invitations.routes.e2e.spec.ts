import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The invitations and the members, over HTTP: an invitation by a link, reading it, joining, and the members in the order
 * they joined, on a database file of its own. The answers are held to the API `api/` gives, through `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-invitations-')), 'tally.sqlite');
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

let accountCount = 0;
/** A signed-in person, with a fresh email, their id and their token. */
async function signedInPerson(name: string): Promise<{ token: string; id: string; name: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  return { token, id: (created.body as { id: string }).id, name };
}

const createGroup = (token: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups`, { body, token });
const createInvitation = (groupId: string, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
const getInvitation = (id: string, token?: string) => http.request('GET', `${api}/invitations/${id}`, { token });
const acceptInvitation = (id: string, token?: string) =>
  http.request('POST', `${api}/invitations/${id}/accept`, { token });
const members = (groupId: string, token?: string) => http.request('GET', `${api}/groups/${groupId}/members`, { token });
const myGroups = (token?: string) => http.request('GET', `${api}/groups/mine`, { token });

/** A group with its owner, and a link to it. */
async function groupWithLink(name: string) {
  const owner = await signedInPerson(`${name}Owner`);
  const { id: groupId } = (await createGroup(owner.token, { name, currency: 'EUR' })).body as { id: string };
  const { id } = (await createInvitation(groupId, owner.token)).body as { id: string };
  return { owner, groupId, invitationId: id };
}

const MISSING = '00000000-0000-4000-8000-000000000000';

describe('creating an invitation', () => {
  it('lets a member create an invitation to the group, answering its id', async () => {
    const owner = await signedInPerson('Maker');
    const { id: groupId } = (await createGroup(owner.token, { name: 'Trip', currency: 'USD' })).body as { id: string };

    const answer = await createInvitation(groupId, owner.token);
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('answers a stranger the same as a group that does not exist, with 404', async () => {
    const owner = await signedInPerson('Closed');
    const stranger = await signedInPerson('Outsider');
    const { id: groupId } = (await createGroup(owner.token, { name: 'Closed', currency: 'CHF' })).body as {
      id: string;
    };

    const denied = await createInvitation(groupId, stranger.token);
    const missing = await createInvitation(MISSING, stranger.token);
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(denied.body).toEqual(missing.body);
  });

  it('refuses a request with no caller with 401, before anything is made', async () => {
    const owner = await signedInPerson('Anon');
    const { id: groupId } = (await createGroup(owner.token, { name: 'Anon', currency: 'EUR' })).body as { id: string };
    expect((await createInvitation(groupId)).status).toBe(401);
  });
});

describe('reading an invitation', () => {
  it('lets anyone signed in who has the link read it, member or not, with the group and who invited them', async () => {
    const { owner, groupId, invitationId } = await groupWithLink('Reading');
    const stranger = await signedInPerson('Reader');

    const answer = await getInvitation(invitationId, stranger.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      id: invitationId,
      groupId,
      groupName: 'Reading',
      invitedBy: owner.id,
    });
  });

  it('answers 404 for a link that does not exist, and 401 with no caller', async () => {
    const reader = await signedInPerson('Missing');
    expect((await getInvitation(MISSING, reader.token)).status).toBe(404);
    const { invitationId } = await groupWithLink('Anonymous');
    expect((await getInvitation(invitationId)).status).toBe(401);
  });
});

describe('joining a group', () => {
  it('makes the caller a member, so the group is among their groups', async () => {
    const { groupId, invitationId } = await groupWithLink('Joining');
    const joiner = await signedInPerson('Joiner');

    const answer = await acceptInvitation(invitationId, joiner.token);
    expect(answer.status).toBe(204);

    const mine = (await myGroups(joiner.token)).body as { id: string }[];
    expect(mine.map(group => group.id)).toContain(groupId);
  });

  it('lets any number of people use the same link', async () => {
    const { groupId, invitationId } = await groupWithLink('Many');
    const people = [await signedInPerson('Many1'), await signedInPerson('Many2'), await signedInPerson('Many3')];

    for (const person of people) {
      expect((await acceptInvitation(invitationId, person.token)).status).toBe(204);
    }
    const listed = (await members(groupId, people[0].token)).body as { memberId: string }[];
    expect(listed.map(member => member.memberId)).toEqual(expect.arrayContaining(people.map(person => person.id)));
  });

  it('refuses a second join by someone who is a member already, with 400', async () => {
    const { owner, invitationId } = await groupWithLink('Twice');
    const joiner = await signedInPerson('Again');
    expect((await acceptInvitation(invitationId, joiner.token)).status).toBe(204);

    const again = await acceptInvitation(invitationId, joiner.token);
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ type: 'AlreadyMember', message: expect.any(String) });

    const refusedOwner = await acceptInvitation(invitationId, owner.token);
    expect(refusedOwner.status).toBe(400);
  });

  it('answers 404 for a link that does not exist, and 401 with no caller', async () => {
    const joiner = await signedInPerson('Nowhere');
    expect((await acceptInvitation(MISSING, joiner.token)).status).toBe(404);
    const { invitationId } = await groupWithLink('NoCaller');
    expect((await acceptInvitation(invitationId)).status).toBe(401);
  });

  it('lets only one of two requests from the same account join, when they race', async () => {
    const { invitationId } = await groupWithLink('Race');
    const joiner = await signedInPerson('Racer');

    const answers = await Promise.all([1, 2, 3].map(() => acceptInvitation(invitationId, joiner.token)));
    expect(answers.map(answer => answer.status).sort()).toEqual([204, 400, 400]);
  });

  it('lets several people who accept at the same time all join, each once', async () => {
    const { groupId, invitationId } = await groupWithLink('Crowd');
    const people = await Promise.all(['Crowd1', 'Crowd2', 'Crowd3', 'Crowd4', 'Crowd5'].map(signedInPerson));

    const answers = await Promise.all(people.map(person => acceptInvitation(invitationId, person.token)));
    expect(answers.map(answer => answer.status)).toEqual([204, 204, 204, 204, 204]);

    const listed = (await members(groupId, people[0].token)).body as { memberId: string }[];
    expect(listed).toHaveLength(6);
    expect(new Set(listed.map(member => member.memberId)).size).toBe(6);
  });
});

describe('the members', () => {
  it('lists them in the order they joined, the owner first, with their name, role and when they joined', async () => {
    const { owner, groupId, invitationId } = await groupWithLink('Ordered');
    const first = await signedInPerson('First');
    const second = await signedInPerson('Second');
    await acceptInvitation(invitationId, first.token);
    await acceptInvitation(invitationId, second.token);

    const answer = await members(groupId, owner.token);
    expect(answer.status).toBe(200);
    const listed = answer.body as { memberId: string; name: string; role: string; joinedAt: string }[];
    expect(listed.map(member => [member.memberId, member.name, member.role])).toEqual([
      [owner.id, owner.name, 'owner'],
      [first.id, 'First', 'member'],
      [second.id, 'Second', 'member'],
    ]);
    for (const member of listed) {
      expect(member.joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    }
    const times = listed.map(member => Date.parse(member.joinedAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('shows the members to a member, and to a stranger the group does not exist', async () => {
    const { owner, groupId } = await groupWithLink('Private');
    const stranger = await signedInPerson('Nosy');

    const denied = await members(groupId, stranger.token);
    const missing = await members(MISSING, stranger.token);
    expect(denied.status).toBe(404);
    expect(denied.body).toEqual(missing.body);
    expect((await members(groupId)).status).toBe(401);
    expect((await members(groupId, owner.token)).status).toBe(200);
  });
});
