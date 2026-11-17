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
type Balance = { memberId: string; balance: number };

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

/** Joins a group by an invitation, following the operation of the join. */
async function join(token: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: joiner });
  await outcome((accepted.body as { operationId: string }).operationId, joiner);
}

/** Records an expense and follows its operation: SUCCESS with the id, or ERROR with the refusal. */
async function record(
  token: string,
  groupId: string,
  body: { description: string; amount: number; date: string; splitBetween: string[] },
): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Reads the balances of a group, as the given member reads them. */
async function balances(token: string, groupId: string): Promise<{ status: number; body: unknown }> {
  return http.get(`${api}/groups/${groupId}/balances`, { token });
}

/** A day long past, which every expense may be spent on. */
const PAST_DAY = '2026-03-10';

describe('balances', () => {
  it('reads the balance of every member, in the order they joined, a member with nothing recorded at 0, and they add up to 0', async () => {
    const alice = await signedIn('bal-alice@example.com', 'Alice');
    const bob = await signedIn('bal-bob@example.com', 'Bob');
    const carl = await signedIn('bal-carl@example.com', 'Carl');
    const dan = await signedIn('bal-dan@example.com', 'Dan');
    const groupId = await createGroup(alice.token, 'Ordered');
    await join(alice.token, groupId, bob.token);
    await join(alice.token, groupId, carl.token);
    await join(alice.token, groupId, dan.token);

    // 1000 split three ways, Alice listed first: 334 to Alice (the remainder), 333 each to Bob and Carl.
    expect(
      await record(alice.token, groupId, {
        description: 'Groceries',
        amount: 1000,
        date: PAST_DAY,
        splitBetween: [alice.id, bob.id, carl.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    // 300 split two ways, paid by Bob, with Carl.
    expect(
      await record(bob.token, groupId, {
        description: 'Fuel',
        amount: 300,
        date: PAST_DAY,
        splitBetween: [bob.id, carl.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    const read = await balances(dan.token, groupId);

    expect(read.status).toBe(200);
    expect(read.body).toEqual([
      { memberId: alice.id, balance: 666 },
      { memberId: bob.id, balance: -183 },
      { memberId: carl.id, balance: -483 },
      { memberId: dan.id, balance: 0 },
    ] satisfies Balance[]);
    const total = (read.body as Balance[]).reduce((sum, member) => sum + member.balance, 0);
    expect(total).toBe(0);
  });

  it('reads 0 for every member of a group where nothing has been recorded', async () => {
    const alice = await signedIn('bal-kay@example.com', 'Alice');
    const bob = await signedIn('bal-lee@example.com', 'Bob');
    const groupId = await createGroup(alice.token, 'Quiet');
    await join(alice.token, groupId, bob.token);

    const read = await balances(alice.token, groupId);

    expect(read.body).toEqual([
      { memberId: alice.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
  });

  it('counts each expense once, and the balances add up to 0, whatever is recorded at once', async () => {
    const alice = await signedIn('bal-max@example.com', 'Alice');
    const bob = await signedIn('bal-ned@example.com', 'Bob');
    const carl = await signedIn('bal-oli@example.com', 'Carl');
    const groupId = await createGroup(alice.token, 'Busy');
    await join(alice.token, groupId, bob.token);
    await join(alice.token, groupId, carl.token);
    const split = [alice.id, bob.id, carl.id];

    // Four expenses of 300 by Alice and five of 300 by Bob, at the same moment; each share is 100.
    const recorded = await Promise.all([
      ...Array.from({ length: 4 }, (_, n) =>
        record(alice.token, groupId, { description: `A${n}`, amount: 300, date: PAST_DAY, splitBetween: split }),
      ),
      ...Array.from({ length: 5 }, (_, n) =>
        record(bob.token, groupId, { description: `B${n}`, amount: 300, date: PAST_DAY, splitBetween: split }),
      ),
    ]);
    expect(recorded.every(operation => operation.status === 'SUCCESS')).toBe(true);

    // Alice: 4 × (300 − 100) − 5 × 100 = 300. Bob: 5 × (300 − 100) − 4 × 100 = 600. Carl: −9 × 100 = −900.
    const read = await balances(carl.token, groupId);
    expect(read.body).toEqual([
      { memberId: alice.id, balance: 300 },
      { memberId: bob.id, balance: 600 },
      { memberId: carl.id, balance: -900 },
    ] satisfies Balance[]);
  });

  it('leaves the balances as they were when an expense is refused', async () => {
    const alice = await signedIn('bal-pam@example.com', 'Alice');
    const bob = await signedIn('bal-quin@example.com', 'Bob');
    const stranger = await signedIn('bal-rae@example.com', 'Rae');
    const groupId = await createGroup(alice.token, 'Refused');
    await join(alice.token, groupId, bob.token);
    await record(alice.token, groupId, {
      description: 'Milk',
      amount: 200,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });
    const before = await balances(alice.token, groupId);

    const refused = await record(alice.token, groupId, {
      description: 'Bread',
      amount: 200,
      date: PAST_DAY,
      splitBetween: [alice.id, stranger.id],
    });

    expect(refused).toMatchObject({ status: 'ERROR', error: { type: 'NotAMemberOfTheGroup' } });
    expect((await balances(alice.token, groupId)).body).toEqual(before.body);
  });

  it('is read by a member of the group only: anyone else is told the group does not exist, and a caller not signed in is 401', async () => {
    const alice = await signedIn('bal-sam@example.com', 'Alice');
    const stranger = await signedIn('bal-tim@example.com', 'Tim');
    const groupId = await createGroup(alice.token, 'Private');

    expect((await balances(stranger.token, groupId)).status).toBe(404);
    expect((await balances(stranger.token, 'nope')).status).toBe(404);
    expect((await http.get(`${api}/groups/${groupId}/balances`)).status).toBe(401);
  });
});

describe('Groups → Ledger', () => {
  it('reads the balances of a group made in Groups by the id its operation answered, with a member who has just joined', async () => {
    const alice = await signedIn('bal-uma@example.com', 'Alice');
    const bob = await signedIn('bal-vic@example.com', 'Bob');
    // Groups makes the group and answers its id; Ledger finds the group by that same id, and a join is read at once.
    const groupId = await createGroup(alice.token, 'Just joined');
    await join(alice.token, groupId, bob.token);

    expect(await balances(bob.token, groupId)).toMatchObject({
      status: 200,
      body: [
        { memberId: alice.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });

    expect(
      await record(alice.token, groupId, {
        description: 'Snacks',
        amount: 100,
        date: PAST_DAY,
        splitBetween: [alice.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect((await balances(bob.token, groupId)).body).toEqual([
      { memberId: alice.id, balance: 50 },
      { memberId: bob.id, balance: -50 },
    ]);
  });
});
