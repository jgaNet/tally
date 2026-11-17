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
type Expense = {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: { memberId: string; amount: number }[];
};

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

/** Records an expense, and follows its operation: the operation's answer, SUCCESS with the id or ERROR with the refusal. */
async function record(
  token: string,
  groupId: string,
  body: { description: string; amount: number; date: string; splitBetween: string[] },
): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** A day long past, which every expense may be spent on; the far future is after any today. */
const PAST_DAY = '2026-03-10';
const FUTURE_DAY = '9999-12-31';

describe('expenses', () => {
  it('splits an amount equally, the remainder to the payer, and lets a member read it in the split order', async () => {
    const alice = await signedIn('ana@example.com', 'Alice');
    const bob = await signedIn('bea@example.com', 'Bob');
    const carl = await signedIn('cai@example.com', 'Carl');
    const groupId = await createGroup(alice.token, 'Flat');
    await join(alice.token, groupId, bob.token);
    await join(alice.token, groupId, carl.token);

    const recorded = await record(alice.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: PAST_DAY,
      splitBetween: [bob.id, alice.id, carl.id],
    });
    expect(recorded).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });

    const read = await http.get(`${api}/expenses/${recorded.result}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id: recorded.result as string,
      groupId,
      description: 'Groceries',
      amount: 1000,
      date: PAST_DAY,
      paidBy: alice.id,
      shares: [
        { memberId: bob.id, amount: 333 },
        { memberId: alice.id, amount: 334 },
        { memberId: carl.id, amount: 333 },
      ],
    } satisfies Expense);
  });

  it('hides an expense from anyone who is not a member of its group, as if it did not exist', async () => {
    const alice = await signedIn('ivo@example.com', 'Alice');
    const stranger = await signedIn('jan@example.com', 'Jan');
    const groupId = await createGroup(alice.token, 'Board games');
    const recorded = await record(alice.token, groupId, {
      description: 'Dice',
      amount: 500,
      date: PAST_DAY,
      splitBetween: [alice.id],
    });

    const read = await http.get(`${api}/expenses/${recorded.result}`, { token: stranger.token });

    expect(read.status).toBe(404);
  });

  it('answers 404 for an expense that is not there, and 401 to a caller who is not signed in', async () => {
    const alice = await signedIn('kim@example.com', 'Alice');

    expect((await http.get(`${api}/expenses/nope`, { token: alice.token })).status).toBe(404);
    expect((await http.get(`${api}/expenses/nope`)).status).toBe(401);
  });

  it('refuses a member who is not signed in before anything is recorded', async () => {
    const alice = await signedIn('lu@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Choir');

    const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Music', amount: 100, date: PAST_DAY, splitBetween: [alice.id] },
    });

    expect(answer.status).toBe(401);
  });

  it('refuses a stranger recording into a group they are not in, as if the group did not exist', async () => {
    const alice = await signedIn('mo@example.com', 'Alice');
    const stranger = await signedIn('ned@example.com', 'Ned');
    const groupId = await createGroup(alice.token, 'Club');

    const recorded = await record(stranger.token, groupId, {
      description: 'Tickets',
      amount: 100,
      date: PAST_DAY,
      splitBetween: [stranger.id],
    });

    expect(recorded).toMatchObject({ status: 'ERROR', error: { type: 'NotFound', message: expect.any(String) } });
  });

  it('refuses a split that breaks the rules, on its operation, each by the rule it breaks', async () => {
    const alice = await signedIn('oli@example.com', 'Alice');
    const bob = await signedIn('pia@example.com', 'Bob');
    const stranger = await signedIn('quin@example.com', 'Quin');
    const groupId = await createGroup(alice.token, 'Flat');
    await join(alice.token, groupId, bob.token);
    const valid = { description: 'Rent part', amount: 100, date: PAST_DAY, splitBetween: [alice.id, bob.id] };

    const cases: [string, Partial<typeof valid>, string][] = [
      ['InvalidDescription', { description: '   ' }, 'blank description'],
      ['InvalidDescription', { description: 'x'.repeat(101) }, 'description over 100'],
      ['InvalidAmount', { amount: 0 }, 'amount of 0'],
      ['InvalidAmount', { amount: 100_000_001 }, 'amount over 100 000 000'],
      ['InvalidDate', { date: '2026-02-30' }, 'a day not in the calendar'],
      ['DateInTheFuture', { date: FUTURE_DAY }, 'a day after today'],
      ['DuplicateSplitMember', { splitBetween: [alice.id, alice.id] }, 'a member listed twice'],
      ['PayerNotInSplit', { splitBetween: [bob.id] }, 'a split without the payer'],
      ['NotAMemberOfTheGroup', { splitBetween: [alice.id, stranger.id] }, 'a split with a stranger'],
    ];
    for (const [type, change] of cases) {
      const refused = await record(alice.token, groupId, { ...valid, ...change });
      expect(refused).toMatchObject({ status: 'ERROR', error: { type, message: expect.any(String) } });
    }
  });

  it('answers 400 to a body of the wrong shape, before the expense decides anything', async () => {
    const alice = await signedIn('rae@example.com', 'Alice');
    const groupId = await createGroup(alice.token, 'Flat');

    const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: alice.token,
      body: { description: 'Milk', amount: 'two', date: PAST_DAY, splitBetween: [alice.id] },
    });

    expect(answer.status).toBe(400);
  });
});

describe('Groups → Ledger', () => {
  it('splits an expense with a member who has just joined Groups, and finds it by the id it answered', async () => {
    const alice = await signedIn('ros@example.com', 'Alice');
    const bob = await signedIn('sam@example.com', 'Bob');
    // Groups makes the group and answers its id; a join is a fact Ledger reads at the moment it decides.
    const groupId = await createGroup(alice.token, 'Just joined');
    await join(alice.token, groupId, bob.token);

    const recorded = await record(alice.token, groupId, {
      description: 'Snacks',
      amount: 101,
      date: PAST_DAY,
      splitBetween: [alice.id, bob.id],
    });
    expect(recorded).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });

    const read = await http.get(`${api}/expenses/${recorded.result}`, { token: bob.token });
    expect(read.body).toMatchObject({
      id: recorded.result,
      groupId,
      shares: [
        { memberId: alice.id, amount: 51 },
        { memberId: bob.id, amount: 50 },
      ],
    });
  });
});
