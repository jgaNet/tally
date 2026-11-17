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

type Operation = { status: string; result?: string; error?: { type: string; message: string } };
type Member = { memberId: string; name: string; role: string; joinedAt: string };
type Invitation = { id: string; groupId: string; groupName: string; invitedBy: string };

/** Follows an operation to its end, as a client answered 202 does. */
async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** Signs someone up and in, under the name given: their account's id, and the token that names it. */
async function signedIn(email: string, name = 'Alice'): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

/** Creates a group and follows its operation: the operation's result is the group's id. */
async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** Creates an invitation to a group and follows its operation: the result is the invitation's id, the link. */
async function invite(token: string, groupId: string): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Accepts an invitation and follows its operation. */
async function accept(token: string, invitationId: string): Promise<Operation> {
  const answer = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

describe('invitations', () => {
  it('lets a member create an invitation, which a stranger reads before joining', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const bob = await signedIn('bea@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Lisbon trip');

    const created = await invite(alice.token, groupId);
    expect(created).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });
    const invitationId = created.result as string;

    const read = await http.get(`${api}/invitations/${invitationId}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id: invitationId,
      groupId,
      groupName: 'Lisbon trip',
      invitedBy: alice.id,
    } satisfies Invitation);
  });

  it('joins the one who accepts, and lists the members in the order they joined, the owner first', async () => {
    const alice = await signedIn('cara@example.com', 'Alice');
    const bob = await signedIn('dora@example.com', 'Bob');
    const carl = await signedIn('ema@example.com', 'Carl');
    const groupId = await createGroup(alice.token, 'Climbing club');
    const invitation = (await invite(alice.token, groupId)).result as string;

    expect(await accept(bob.token, invitation)).toMatchObject({ status: 'SUCCESS' });
    expect(await accept(carl.token, invitation)).toMatchObject({ status: 'SUCCESS' });

    const members = await http.get(`${api}/groups/${groupId}/members`, { token: alice.token });
    expect(members.status).toBe(200);
    const list = members.body as Member[];
    expect(list.map(member => [member.memberId, member.name, member.role])).toEqual([
      [alice.id, 'Alice', 'owner'],
      [bob.id, 'Bob', 'member'],
      [carl.id, 'Carl', 'member'],
    ]);
    expect(list.map(member => member.joinedAt)).toEqual([...list.map(member => member.joinedAt)].sort());
    expect(list[0].joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('puts a joined group among the groups of the one who joined', async () => {
    const alice = await signedIn('fay@example.com', 'Alice');
    const bob = await signedIn('gil@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Flat');
    const invitation = (await invite(alice.token, groupId)).result as string;

    await accept(bob.token, invitation);

    const mine = (await http.get(`${api}/groups/mine`, { token: bob.token })).body as { id: string }[];
    expect(mine.map(group => group.id)).toContain(groupId);
  });

  it('refuses a second join of the same account, on its operation', async () => {
    const alice = await signedIn('hal@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Choir');
    const invitation = (await invite(alice.token, groupId)).result as string;

    const again = await accept(alice.token, invitation);

    expect(again).toMatchObject({ status: 'ERROR', error: { type: 'AlreadyAMember', message: expect.any(String) } });
  });

  it('hides the group from anyone who is not a member: no invitation, no members, as if it did not exist', async () => {
    const alice = await signedIn('ivo@example.com', 'Alice');
    const stranger = await signedIn('jan@example.com', 'Jan');
    const groupId = await createGroup(alice.token, 'Board games');

    const invitation = await invite(stranger.token, groupId);
    const members = await http.get(`${api}/groups/${groupId}/members`, { token: stranger.token });

    expect(invitation).toMatchObject({ status: 'ERROR', error: { type: 'NotFound', message: expect.any(String) } });
    expect(members.status).toBe(404);
  });

  it('answers 404 for an invitation that is not there, and 401 to a caller who is not signed in', async () => {
    const alice = await signedIn('kim@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Book club');
    const invitation = (await invite(alice.token, groupId)).result as string;

    expect(
      (await http.get(`${api}/invitations/00000000-0000-4000-8000-000000000000`, { token: alice.token })).status,
    ).toBe(404);
    expect((await http.get(`${api}/invitations/${invitation}`)).status).toBe(401);
    expect((await http.request('POST', `${api}/groups/${groupId}/invitations`)).status).toBe(401);
    expect((await http.request('POST', `${api}/invitations/${invitation}/accept`)).status).toBe(401);
    expect((await http.get(`${api}/groups/${groupId}/members`)).status).toBe(401);
  });
});
