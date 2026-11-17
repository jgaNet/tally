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
    body: { email: 'clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(() => app.stop());

type Body = Record<string, unknown>;
type Balance = { memberId: string; balance: number };

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
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group and answers its id, as a client does: `202`, then the operation followed to its outcome. */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
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

/** Records an expense as a client does: the `202`, then the operation followed to its outcome. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  if (answer.status !== 202) return { answer, done: undefined };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { answer, done: done.body as Body };
}

/** The balances of the group, read by a member as a client does. */
async function balances(groupId: string, token: string) {
  return http.get(`${api}/groups/${groupId}/balances`, { token });
}

const sum = (list: Balance[]) => list.reduce((total, each) => total + each.balance, 0);

/** A group of three: Alice (its owner), Bob and Carol, who joined in that order. */
async function threeMembers() {
  const alice = await person('Alice');
  const bob = await person('Bob');
  const carol = await person('Carol');
  const groupId = await createGroup(alice);
  await join(groupId, alice, bob);
  await join(groupId, alice, carol);
  return { alice, bob, carol, groupId };
}

describe("a group's balances", () => {
  it('lists every member in the order they joined, each at 0 when nothing is recorded', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const { status, body } = await balances(groupId, alice.token);
    expect(status).toBe(200);
    expect(body).toEqual([
      { memberId: alice.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
      { memberId: carol.id, balance: 0 },
    ]);
  });

  it('gives the payer what the others owe them, and each other member what they owe, and adds up to 0', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    await record(alice.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: serverToday,
      splitBetween: [bob.id, carol.id, alice.id],
    });
    const { status, body } = await balances(groupId, bob.token);
    expect(status).toBe(200);
    // Alice paid 1000 and owes her share of 333: she is owed 667; Bob, listed first, owes 334 and Carol owes 333.
    expect(body).toEqual([
      { memberId: alice.id, balance: 667 },
      { memberId: bob.id, balance: -334 },
      { memberId: carol.id, balance: -333 },
    ]);
    expect(sum(body as Balance[])).toBe(0);
  });

  it('nets the expenses of several payers, and keeps a member who is in no split at 0 in their place', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const dave = await person('Dave');
    await join(groupId, alice, dave);
    await record(alice.token, groupId, {
      description: 'Rent',
      amount: 100,
      date: serverToday,
      splitBetween: [alice.id, bob.id],
    });
    await record(bob.token, groupId, {
      description: 'Taxi',
      amount: 60,
      date: serverToday,
      splitBetween: [bob.id, carol.id],
    });
    const { body } = await balances(groupId, carol.token);
    // Alice: +100 - 50 = +50; Bob: -50 + 60 - 30 = -20; Carol: -30; Dave is in no split.
    expect(body).toEqual([
      { memberId: alice.id, balance: 50 },
      { memberId: bob.id, balance: -20 },
      { memberId: carol.id, balance: -30 },
      { memberId: dave.id, balance: 0 },
    ]);
    expect(sum(body as Balance[])).toBe(0);
  });

  it('counts each expense once when twenty are recorded at the same moment, and still adds up to 0', async () => {
    const { alice, bob, carol, groupId } = await threeMembers();
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        http.request('POST', `${api}/groups/${groupId}/expenses`, {
          body: {
            description: `Round ${index}`,
            amount: 90,
            date: serverToday,
            splitBetween: index % 2 === 0 ? [alice.id, bob.id, carol.id] : [bob.id, carol.id, alice.id],
          },
          token: index % 2 === 0 ? alice.token : bob.token,
        }),
      ),
    );
    expect(answers.every(answer => answer.status === 202)).toBe(true);
    await Promise.all(answers.map(answer => outcome((answer.body as Body).operationId as string, alice.token)));

    const { body } = await balances(groupId, alice.token);
    // Ten paid by Alice and ten by Bob, 90 each split three ways (30 a share). Alice paid 10 × (90 - 30) = +600 and has
    // a share of 10 × 30 = -300 on Bob's, so +300; Bob is likewise +300; Carol has 20 shares of 30, so -600.
    expect(body).toEqual([
      { memberId: alice.id, balance: 300 },
      { memberId: bob.id, balance: 300 },
      { memberId: carol.id, balance: -600 },
    ]);
    expect(sum(body as Balance[])).toBe(0);
  });

  it('answers 404 to anyone who is not a member, as if the group did not exist', async () => {
    const { alice, groupId } = await threeMembers();
    const stranger = await person('Stranger');
    expect((await balances(groupId, stranger.token)).status).toBe(404);
    expect((await balances('no-such-group', alice.token)).status).toBe(404);
  });

  it('refuses a caller who is not signed in at once with 401', async () => {
    const { groupId } = await threeMembers();
    const { status } = await http.get(`${api}/groups/${groupId}/balances`);
    expect(status).toBe(401);
  });
});

describe('Groups → Ledger (GroupMembers): the members Groups has are the ones Ledger lists', () => {
  it('reads, in Ledger, the group Groups made by the id its request answered, and finds each member who joined it', async () => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const groupId = await createGroup(alice);
    await join(groupId, alice, bob);

    const { status, body } = await balances(groupId, bob.token);
    expect(status).toBe(200);
    expect(body).toEqual([
      { memberId: alice.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
  });
});
