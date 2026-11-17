import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'settle-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(() => app.stop());

type Body = Record<string, unknown>;
type Transfer = { from: string; to: string; amount: number };

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
  const email = `settle-${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group and answers its id, as a client does: `202`, then the operation followed to its outcome. */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Trip', currency: 'EUR' },
    token: owner.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** A member of the group invites someone, who accepts: the new member joins, and the operation is followed. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

/** Records an expense as a client does: the `202`, then the operation followed to its outcome; answers the expense's id. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: answer.status, expenseId: (done.body as { result?: { id: string } }).result?.id };
}

/** The transfers the group suggests, read by a member as a client does. */
async function suggested(groupId: string, token?: string) {
  return http.get(`${api}/groups/${groupId}/settlements/suggested`, { token });
}

describe('Ledger → Settlements (GroupBalances): the suggestion is made from the balances the expenses make', () => {
  it('suggests the transfers that clear the expenses recorded, and reads the expense by the id its request answered', async () => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const carol = await person('Carol');
    const groupId = await createGroup(alice);
    await join(groupId, alice, bob);
    await join(groupId, alice, carol);

    const recorded = await record(alice.token, groupId, {
      description: 'Dinner',
      amount: 900,
      date: serverToday,
      splitBetween: [alice.id, bob.id, carol.id],
    });
    expect(recorded.status).toBe(202);
    const expense = await http.get(`${api}/expenses/${recorded.expenseId}`, { token: alice.token });
    expect(expense.status).toBe(200);

    // Alice is owed 600, Bob and Carol each owe 300: Bob, who joined first, pays Alice first.
    const { status, body } = await suggested(groupId, bob.token);
    expect(status).toBe(200);
    expect(body).toEqual([
      { from: bob.id, to: alice.id, amount: 300 },
      { from: carol.id, to: alice.id, amount: 300 },
    ]);
  });

  it('suggests nothing for a group whose balances are all 0', async () => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const groupId = await createGroup(alice);
    await join(groupId, alice, bob);

    const { status, body } = await suggested(groupId, alice.token);
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });
});

describe('Groups → Settlements (SettlementMembers): the suggestion is between the members Groups lists, in the order they joined', () => {
  it('suggests between the members by the ids their accounts answered, earliest joined first, and leaves out a member in no split', async () => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const carol = await person('Carol');
    const dave = await person('Dave');
    const groupId = await createGroup(alice);
    await join(groupId, alice, bob);
    await join(groupId, alice, carol);
    await join(groupId, alice, dave);

    const recorded = await record(alice.token, groupId, {
      description: 'Tickets',
      amount: 600,
      date: serverToday,
      splitBetween: [alice.id, bob.id, carol.id],
    });
    expect(recorded.status).toBe(202);

    // Alice paid 600 and owes 200 of it: she is owed 400, Bob and Carol owe 200 each, Bob having joined first.
    // Dave is in no split, so he is at 0 and in no transfer.
    const { status, body } = await suggested(groupId, carol.token);
    expect(status).toBe(200);
    expect(body).toEqual([
      { from: bob.id, to: alice.id, amount: 200 },
      { from: carol.id, to: alice.id, amount: 200 },
    ]);
    expect((body as Transfer[]).some(transfer => transfer.from === dave.id || transfer.to === dave.id)).toBe(false);
  });

  it('answers 404 to anyone who is not a member, as if the group did not exist, and 401 to a caller not signed in', async () => {
    const alice = await person('Alice');
    const groupId = await createGroup(alice);
    const stranger = await person('Stranger');

    expect((await suggested(groupId, stranger.token)).status).toBe(404);
    expect((await suggested('no-such-group', alice.token)).status).toBe(404);
    expect((await suggested(groupId)).status).toBe(401);
  });
});
