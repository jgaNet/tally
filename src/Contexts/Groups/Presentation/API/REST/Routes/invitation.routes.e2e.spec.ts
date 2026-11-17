import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Invitations and members, end to end: the application booted in this process on a free port, spoken to over HTTP,
 * every answer held to api/3-invite-and-join.yaml by the client. One application per suite, shared by its tests in order.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group founded by its owner, answered its id. */
async function groupOf(owner: { token: string }, name: string): Promise<string> {
  const created = await http.request('POST', '/v1/groups', { body: { name, currency: 'EUR' }, token: owner.token });
  return (created.body as { id: string }).id;
}

const invite = (groupId: string, token?: string) =>
  http.request('POST', `/v1/groups/${groupId}/invitations`, { token });
const readInvitation = (id: string, token?: string) => http.get(`/v1/invitations/${id}`, { token });
const accept = (id: string, token?: string) => http.request('POST', `/v1/invitations/${id}/accept`, { token });
const members = (groupId: string, token?: string) => http.get(`/v1/groups/${groupId}/members`, { token });
const myGroups = (token?: string) => http.get('/v1/groups/mine', { token });

describe('creating an invitation', () => {
  it('lets a member create an invitation to the group, and answers its id at once', async () => {
    const ana = await accountOf('ana.invite@example.com', 'Ana');
    const groupId = await groupOf(ana, 'Ski trip');

    const answer = await invite(groupId, ana.token);

    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: expect.any(String) });
  });

  it('answers a different id for each invitation, long enough to be impossible to guess', async () => {
    const ana = await accountOf('ana.ids@example.com', 'Ana');
    const groupId = await groupOf(ana, 'Ids');

    const first = (await invite(groupId, ana.token)).body as { id: string };
    const second = (await invite(groupId, ana.token)).body as { id: string };

    expect(first.id).not.toEqual(second.id);
    expect(first.id.length).toBeGreaterThanOrEqual(32);
  });

  it('answers a group that does not exist to someone who is not a member, as if it were not there', async () => {
    const ana = await accountOf('ana.stranger@example.com', 'Ana');
    const ben = await accountOf('ben.stranger@example.com', 'Ben');
    const groupId = await groupOf(ana, 'Private');

    const stranger = await invite(groupId, ben.token);
    const unknown = await invite('no-such-group', ben.token);

    expect(stranger.status).toBe(404);
    expect(stranger.body).toMatchObject({ type: 'NotFound' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(stranger.body);
  });

  it('refuses a caller who is not signed in', async () => {
    const ana = await accountOf('ana.anon-invite@example.com', 'Ana');
    const groupId = await groupOf(ana, 'Anon');

    const answer = await invite(groupId);

    expect(answer.status).toBe(401);
  });
});

describe('reading an invitation', () => {
  it('lets a signed-in person who is not a member read the group and who invited them', async () => {
    const ana = await accountOf('ana.read-inv@example.com', 'Ana');
    const ben = await accountOf('ben.read-inv@example.com', 'Ben');
    const groupId = await groupOf(ana, 'Lisbon');
    const id = ((await invite(groupId, ana.token)).body as { id: string }).id;

    const answer = await readInvitation(id, ben.token);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ id, groupId, groupName: 'Lisbon', invitedBy: ana.id });
  });

  it('refuses a read with no token, and answers an unknown link as not found', async () => {
    const ana = await accountOf('ana.read-anon@example.com', 'Ana');
    const groupId = await groupOf(ana, 'Anon read');
    const id = ((await invite(groupId, ana.token)).body as { id: string }).id;

    const anonymous = await readInvitation(id);
    const unknown = await readInvitation('no-such-link', ana.token);

    expect(anonymous.status).toBe(401);
    expect(unknown.status).toBe(404);
  });
});

describe('joining a group', () => {
  it('makes the signed-in person a member, answers the group they joined, and lists it among their groups', async () => {
    const ana = await accountOf('ana.join@example.com', 'Ana');
    const cara = await accountOf('cara.join@example.com', 'Cara');
    const groupId = await groupOf(ana, 'Book club');
    const id = ((await invite(groupId, ana.token)).body as { id: string }).id;

    const answer = await accept(id, cara.token);

    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: groupId });
    const mine = await myGroups(cara.token);
    expect(mine.body).toEqual([expect.objectContaining({ id: groupId, name: 'Book club', ownerId: ana.id })]);
  });

  it('lets any number of people join by the same link, each once', async () => {
    const ana = await accountOf('ana.many@example.com', 'Ana');
    const dan = await accountOf('dan.many@example.com', 'Dan');
    const eli = await accountOf('eli.many@example.com', 'Eli');
    const groupId = await groupOf(ana, 'Many');
    const id = ((await invite(groupId, ana.token)).body as { id: string }).id;

    const first = await accept(id, dan.token);
    const second = await accept(id, eli.token);
    const again = await accept(id, dan.token);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ type: 'AlreadyMember' });
  });

  it('refuses the owner, who is already a member, to join again', async () => {
    const ana = await accountOf('ana.owner-join@example.com', 'Ana');
    const groupId = await groupOf(ana, 'Owner');
    const id = ((await invite(groupId, ana.token)).body as { id: string }).id;

    const answer = await accept(id, ana.token);

    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ type: 'AlreadyMember' });
  });

  it('refuses a caller who is not signed in, and an unknown link', async () => {
    const ana = await accountOf('ana.accept-anon@example.com', 'Ana');
    const groupId = await groupOf(ana, 'Accept anon');
    const id = ((await invite(groupId, ana.token)).body as { id: string }).id;

    const anonymous = await accept(id);
    const unknown = await accept('no-such-link', ana.token);

    expect(anonymous.status).toBe(401);
    expect(unknown.status).toBe(404);
  });
});

describe('the members of a group', () => {
  it('lists the members in the order they joined, the owner first, each with its name, role and when it joined', async () => {
    const ana = await accountOf('ana.members@example.com', 'Ana');
    const ben = await accountOf('ben.members@example.com', 'Ben');
    const cara = await accountOf('cara.members@example.com', 'Cara');
    const groupId = await groupOf(ana, 'Ordered');
    const id = ((await invite(groupId, ana.token)).body as { id: string }).id;
    await accept(id, cara.token);
    await accept(id, ben.token);

    const answer = await members(groupId, ben.token);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { memberId: ana.id, name: 'Ana', role: 'owner', joinedAt: expect.any(String) },
      { memberId: cara.id, name: 'Cara', role: 'member', joinedAt: expect.any(String) },
      { memberId: ben.id, name: 'Ben', role: 'member', joinedAt: expect.any(String) },
    ]);
    const joined = (answer.body as Array<{ joinedAt: string }>).map(member => Date.parse(member.joinedAt));
    expect(joined).toEqual([...joined].sort((a, b) => a - b));
  });

  it('answers a group that does not exist to someone who is not a member, as if it were not there', async () => {
    const ana = await accountOf('ana.members-hidden@example.com', 'Ana');
    const ben = await accountOf('ben.members-hidden@example.com', 'Ben');
    const groupId = await groupOf(ana, 'Hidden members');

    const stranger = await members(groupId, ben.token);
    const unknown = await members('no-such-group', ben.token);

    expect(stranger.status).toBe(404);
    expect(unknown.body).toEqual(stranger.body);
  });

  it('refuses a read with no token', async () => {
    const ana = await accountOf('ana.members-anon@example.com', 'Ana');
    const groupId = await groupOf(ana, 'Anon members');

    const answer = await members(groupId);

    expect(answer.status).toBe(401);
  });
});
