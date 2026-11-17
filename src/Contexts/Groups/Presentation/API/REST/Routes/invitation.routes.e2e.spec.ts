import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});

afterAll(() => app.stop());

type Body = Record<string, unknown>;

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id, name };
}

/** Creates a group as its owner does, and answers its id. */
async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { body: { name, currency: 'EUR' }, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return (done.body as { result: { id: string } }).result.id;
}

/** Creates an invitation to a group, and answers the operation's outcome. */
async function invite(token: string, groupId: string) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  if (answer.status !== 202) return { status: answer.status, body: undefined };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: answer.status, body: done.body as Body };
}

/** Accepts an invitation, and answers the operation's outcome. */
async function accept(token: string | undefined, invitationId: string) {
  const answer = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token });
  if (answer.status !== 202) return { status: answer.status, body: answer.body as Body };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: answer.status, body: done.body as Body };
}

/** A group with an invitation to it, made by its owner. */
async function groupWithInvitation(name: string) {
  const alice = await person(`${name}Owner`);
  const groupId = await createGroup(alice.token, name);
  const created = await invite(alice.token, groupId);
  const invitationId = (created.body as { result: { id: string } }).result.id;
  return { alice, groupId, invitationId };
}

describe('creating an invitation', () => {
  it('answers 202, and the operation succeeds with the id of the invitation, the link', async () => {
    const { alice, groupId } = await groupWithInvitation('Link');
    const answer = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: alice.token });
    expect(answer.status).toBe(202);
    const created = await invite(alice.token, groupId);
    expect(created.body).toMatchObject({ status: 'SUCCESS', result: { id: expect.any(String) } });
    const id = (created.body as { result: { id: string } }).result.id;
    expect(id.length).toBeGreaterThanOrEqual(32);
  });

  it('gives each invitation its own id, and an invitation stays usable', async () => {
    const { alice, groupId, invitationId } = await groupWithInvitation('Several');
    const second = await invite(alice.token, groupId);
    const secondId = (second.body as { result: { id: string } }).result.id;
    expect(secondId).not.toBe(invitationId);
    const read = await http.get(`${api}/invitations/${invitationId}`, { token: alice.token });
    expect(read.status).toBe(200);
  });

  it('refuses a person who is not a member, behind the 202, exactly as for a group that does not exist', async () => {
    const { groupId } = await groupWithInvitation('Closed');
    const outsider = await person('Outsider');
    const notMember = await invite(outsider.token, groupId);
    const unknown = await invite(outsider.token, 'no-such-group');
    expect(notMember.status).toBe(202);
    expect(notMember.body).toMatchObject({ status: 'ERROR', error: { type: 'NotFound', message: expect.any(String) } });
    expect(notMember.body?.error).toEqual(unknown.body?.error);
  });

  it('refuses no token at once with 401', async () => {
    const { groupId } = await groupWithInvitation('Anonymous');
    const answer = await http.request('POST', `${api}/groups/${groupId}/invitations`);
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ message: 'Authentication required' });
  });
});

describe('reading an invitation', () => {
  it('answers the group, its name and who invited, to a signed-in person who is not a member', async () => {
    const { alice, groupId, invitationId } = await groupWithInvitation('Reading');
    const stranger = await person('Stranger');
    const answer = await http.get(`${api}/invitations/${invitationId}`, { token: stranger.token });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      id: invitationId,
      groupId,
      groupName: 'Reading',
      invitedBy: alice.id,
    });
  });

  it('answers 404 for an invitation that does not exist, and 401 without a token', async () => {
    const stranger = await person('Lost');
    expect((await http.get(`${api}/invitations/no-such-link`, { token: stranger.token })).status).toBe(404);
    expect((await http.get(`${api}/invitations/no-such-link`)).status).toBe(401);
  });
});

describe('accepting an invitation', () => {
  it('makes the caller a member, once: the group is then among their groups', async () => {
    const { groupId, invitationId } = await groupWithInvitation('Joining');
    const bob = await person('Bob');
    const answer = await accept(bob.token, invitationId);
    expect(answer.body).toMatchObject({ status: 'SUCCESS' });

    const mine = await http.get(`${api}/groups/mine`, { token: bob.token });
    expect((mine.body as { id: string }[]).map(group => group.id)).toContain(groupId);
  });

  it('refuses a second join of the same group by the same account, with AlreadyMember', async () => {
    const { invitationId } = await groupWithInvitation('Twice');
    const bob = await person('Again');
    expect((await accept(bob.token, invitationId)).body).toMatchObject({ status: 'SUCCESS' });
    expect((await accept(bob.token, invitationId)).body).toMatchObject({
      status: 'ERROR',
      error: { type: 'AlreadyMember', message: expect.any(String) },
    });
  });

  it('refuses the owner joining their own group again, with AlreadyMember', async () => {
    const { alice, invitationId } = await groupWithInvitation('Own');
    expect((await accept(alice.token, invitationId)).body).toMatchObject({
      status: 'ERROR',
      error: { type: 'AlreadyMember' },
    });
  });

  it('lets any number of people join by the same link', async () => {
    const { invitationId, groupId, alice } = await groupWithInvitation('Many');
    const carol = await person('Carol');
    const dave = await person('Dave');
    expect((await accept(carol.token, invitationId)).body).toMatchObject({ status: 'SUCCESS' });
    expect((await accept(dave.token, invitationId)).body).toMatchObject({ status: 'SUCCESS' });

    const members = await http.get(`${api}/groups/${groupId}/members`, { token: alice.token });
    expect((members.body as { memberId: string }[]).map(member => member.memberId)).toEqual([
      alice.id,
      carol.id,
      dave.id,
    ]);
  });

  it('answers an ERROR for an invitation that does not exist, behind the 202', async () => {
    const bob = await person('Nowhere');
    const answer = await accept(bob.token, 'no-such-link');
    expect(answer.status).toBe(202);
    expect(answer.body).toMatchObject({ status: 'ERROR', error: { type: 'NotFound' } });
  });

  it('refuses no token at once with 401, and joins nobody', async () => {
    const { invitationId, groupId, alice } = await groupWithInvitation('Silent');
    const answer = await http.request('POST', `${api}/invitations/${invitationId}/accept`);
    expect(answer.status).toBe(401);
    const members = await http.get(`${api}/groups/${groupId}/members`, { token: alice.token });
    expect(members.body as unknown[]).toHaveLength(1);
  });
});

describe('the members of a group', () => {
  it('lists them in the order they joined, the owner first, with name, role and when each joined', async () => {
    const { alice, groupId, invitationId } = await groupWithInvitation('Ordered');
    const bob = await person('Ben');
    const carol = await person('Cleo');
    await accept(bob.token, invitationId);
    await accept(carol.token, invitationId);

    const answer = await http.get(`${api}/groups/${groupId}/members`, { token: alice.token });
    expect(answer.status).toBe(200);
    const members = answer.body as { memberId: string; name: string; role: string; joinedAt: string }[];
    expect(members.map(({ memberId, name, role }) => ({ memberId, name, role }))).toEqual([
      { memberId: alice.id, name: 'OrderedOwner', role: 'owner' },
      { memberId: bob.id, name: 'Ben', role: 'member' },
      { memberId: carol.id, name: 'Cleo', role: 'member' },
    ]);
    const joinedAt = members.map(member => Date.parse(member.joinedAt));
    expect(joinedAt[0]).toBeLessThanOrEqual(joinedAt[1]);
    expect(joinedAt[1]).toBeLessThanOrEqual(joinedAt[2]);
  });

  it('lets a member of the group read the list, and a member who joined read it too', async () => {
    const { groupId, invitationId } = await groupWithInvitation('Shared');
    const bob = await person('Eli');
    await accept(bob.token, invitationId);
    const answer = await http.get(`${api}/groups/${groupId}/members`, { token: bob.token });
    expect(answer.status).toBe(200);
    expect(answer.body as unknown[]).toHaveLength(2);
  });

  it('answers 404 to anyone who is not a member, exactly as for a group that does not exist', async () => {
    const { alice, groupId } = await groupWithInvitation('Private');
    const outsider = await person('Snoop');
    const notMember = await http.get(`${api}/groups/${groupId}/members`, { token: outsider.token });
    const unknown = await http.get(`${api}/groups/no-such-group/members`, { token: outsider.token });
    expect(notMember.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(notMember.body).toEqual(unknown.body);
    expect(alice.id).toBeTruthy();
  });

  it('refuses no token at once with 401', async () => {
    expect((await http.get(`${api}/groups/anything/members`)).status).toBe(401);
  });
});
