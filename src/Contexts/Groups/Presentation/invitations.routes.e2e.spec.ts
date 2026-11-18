import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('invitations');

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  await database;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

const PASSWORD = 'a-good-password';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group of its owner's, and the link to it. */
async function groupWithLink(owner: { token: string }, name = 'Lisbon trip') {
  const created = await http.request('POST', `${api}/groups`, {
    body: { name, currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  return { groupId, invitationId: (invitation.body as { id: string }).id };
}

const createInvitation = (groupId: string, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
const readInvitation = (id: string, token?: string) => http.request('GET', `${api}/invitations/${id}`, { token });
const accept = (id: string, token?: string) => http.request('POST', `${api}/invitations/${id}/accept`, { token });
const members = (groupId: string, token?: string) => http.request('GET', `${api}/groups/${groupId}/members`, { token });
const myGroups = (token: string) => http.request('GET', `${api}/groups/mine`, { token });

describe('invitations', () => {
  it('lets a member make an invitation, answering 201 with its id, the link', async () => {
    const ada = await signedIn('ada@example.com', 'Ada');
    const { groupId } = await groupWithLink(ada);

    const made = await createInvitation(groupId, ada.token);

    expect(made.status).toBe(201);
    expect(made.body).toEqual({ id: expect.any(String) });
  });

  it('refuses an invitation to someone who is not a member, as if the group did not exist', async () => {
    const ada = await signedIn('ada2@example.com', 'Ada');
    const bob = await signedIn('bob2@example.com', 'Bob');
    const { groupId } = await groupWithLink(ada);

    const notMine = await createInvitation(groupId, bob.token);
    const unknown = await createInvitation(UNKNOWN, bob.token);

    expect(notMine).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect(notMine.body).toEqual(unknown.body);
  });

  it('refuses a missing caller with 401 when an invitation is made, and when it is read or accepted', async () => {
    const ada = await signedIn('ada3@example.com', 'Ada');
    const { groupId, invitationId } = await groupWithLink(ada);

    expect((await createInvitation(groupId)).status).toBe(401);
    expect((await readInvitation(invitationId)).status).toBe(401);
    expect((await accept(invitationId)).status).toBe(401);
  });

  it('answers an invitation to anyone signed in who has its link, before they are a member', async () => {
    const ada = await signedIn('ada4@example.com', 'Ada');
    const bob = await signedIn('bob4@example.com', 'Bob');
    const { groupId, invitationId } = await groupWithLink(ada, 'Climbing');

    expect(await readInvitation(invitationId, bob.token)).toMatchObject({
      status: 200,
      body: { id: invitationId, groupId, groupName: 'Climbing', invitedBy: ada.id },
    });
    expect(await readInvitation(UNKNOWN, bob.token)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
  });

  it('lets a signed-in person join by the link, who then sees the group and lists it among theirs', async () => {
    const ada = await signedIn('ada5@example.com', 'Ada');
    const bob = await signedIn('bob5@example.com', 'Bob');
    const { groupId, invitationId } = await groupWithLink(ada);

    expect(await accept(invitationId, bob.token)).toMatchObject({ status: 204 });

    expect(await http.request('GET', `${api}/groups/${groupId}`, { token: bob.token })).toMatchObject({ status: 200 });
    expect((await myGroups(bob.token)).body).toContainEqual(expect.objectContaining({ id: groupId }));
  });

  it('refuses a member who joins again: 409, and the members do not change', async () => {
    const ada = await signedIn('ada6@example.com', 'Ada');
    const bob = await signedIn('bob6@example.com', 'Bob');
    const { groupId, invitationId } = await groupWithLink(ada);
    await accept(invitationId, bob.token);

    expect(await accept(invitationId, bob.token)).toMatchObject({ status: 409, body: { type: 'AlreadyExists' } });
    expect(await accept(invitationId, ada.token)).toMatchObject({ status: 409, body: { type: 'AlreadyExists' } });
    expect((await members(groupId, ada.token)).body).toHaveLength(2);
  });

  it('answers 404 for an invitation that does not exist, when accepted', async () => {
    const bob = await signedIn('bob7@example.com', 'Bob');

    expect(await accept(UNKNOWN, bob.token)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
  });

  it('keeps one link usable by any number of people', async () => {
    const ada = await signedIn('ada8@example.com', 'Ada');
    const bob = await signedIn('bob8@example.com', 'Bob');
    const carol = await signedIn('carol8@example.com', 'Carol');
    const { groupId, invitationId } = await groupWithLink(ada);

    expect((await accept(invitationId, bob.token)).status).toBe(204);
    expect((await accept(invitationId, carol.token)).status).toBe(204);
    expect((await readInvitation(invitationId, carol.token)).status).toBe(200);

    expect((await members(groupId, ada.token)).body).toHaveLength(3);
  });

  it('lists the members in the order they joined, the owner first, with the name, the role and the join date', async () => {
    const ada = await signedIn('ada9@example.com', 'Ada');
    const bob = await signedIn('bob9@example.com', 'Bob');
    const carol = await signedIn('carol9@example.com', 'Carol');
    const { groupId, invitationId } = await groupWithLink(ada);
    await accept(invitationId, carol.token);
    await accept(invitationId, bob.token);

    const listed = await members(groupId, bob.token);

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      { memberId: ada.id, name: 'Ada', role: 'owner', joinedAt: expect.stringMatching(/Z$/) },
      { memberId: carol.id, name: 'Carol', role: 'member', joinedAt: expect.stringMatching(/Z$/) },
      { memberId: bob.id, name: 'Bob', role: 'member', joinedAt: expect.stringMatching(/Z$/) },
    ]);
  });

  it('lists the members to a member only: to anyone else the group does not exist', async () => {
    const ada = await signedIn('ada10@example.com', 'Ada');
    const bob = await signedIn('bob10@example.com', 'Bob');
    const { groupId } = await groupWithLink(ada);

    const notMine = await members(groupId, bob.token);
    const unknown = await members(UNKNOWN, bob.token);

    expect(notMine).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect(notMine.body).toEqual(unknown.body);
    expect((await members(groupId)).status).toBe(401);
  });

  it('keeps the members and their join order across a restart of the application', async () => {
    const ada = await signedIn('ada11@example.com', 'Ada');
    const bob = await signedIn('bob11@example.com', 'Bob');
    const { groupId, invitationId } = await groupWithLink(ada);
    await accept(invitationId, bob.token);

    await app.stop();
    await database;
    app = await createApplication();
    await app.start(0);
    http = apiClient(app.address);

    expect((await members(groupId, ada.token)).body).toEqual([
      expect.objectContaining({ memberId: ada.id, role: 'owner' }),
      expect.objectContaining({ memberId: bob.id, role: 'member' }),
    ]);
  });
});
