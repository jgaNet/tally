import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * Request 21: an expense paid in another currency than its group's, at the rate its payer states. The expense keeps what
 * was paid and the rate, its amount is the group's, and the split and the balances count that amount.
 */

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
    body: { email: 'clock-currency@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
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
  const email = `${name.toLowerCase()}-currency-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group in `currency` and answers its id, as a client does. */
async function createGroup(owner: { token: string }, currency = 'EUR') {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Zurich week', currency },
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

/** A group in euros: Alice (its owner) and Bob, who joined after her. */
async function twoMembers() {
  const alice = await person('Alice');
  const bob = await person('Bob');
  const groupId = await createGroup(alice);
  await join(groupId, alice, bob);
  return { alice, bob, groupId };
}

/** Sends a command as a client does: the `202`, then the operation followed to its outcome. */
async function send(method: 'POST' | 'PUT', path: string, token: string | undefined, body: Body) {
  const answer = await http.request(method, `${api}${path}`, { body, token });
  if (answer.status !== 202) return { answer, done: undefined as Body | undefined };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { answer, done: done.body as Body };
}

/** The day as the server reads it, so the spec reads no clock of its own. */
const today = () => serverToday;

const expenseOf = async (id: string, token: string) =>
  (await http.get(`${api}/expenses/${id}`, { token })).body as Body;

describe('recording an expense in another currency', () => {
  it('records 1234 USD at 1.0625 in a group in euros: the amount is 1311, the original and the rate are kept', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { answer, done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Dinner in Zurich',
      original: { currency: 'USD', amount: 1234, rate: '1.0625' },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'SUCCESS', result: { id: expect.any(String) } });

    const id = (done as { result: { id: string } }).result.id;
    const expense = await expenseOf(id, alice.token);
    expect(expense).toMatchObject({
      id,
      groupId,
      amount: 1311,
      original: { currency: 'USD', amount: 1234, rate: '1.0625' },
      splitKind: 'equal',
    });
    const shares = expense.shares as { amount: number }[];
    expect(shares.reduce((total, share) => total + share.amount, 0)).toBe(1311);
  });

  it('rounds 1000 at 0.9545 to 955 and splits that amount: the member listed first takes the remainder', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const carol = await person('Carol');
    await join(groupId, alice, carol);
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Taxi',
      original: { currency: 'CHF', amount: 1000, rate: '0.9545' },
      date: today(),
      splitBetween: [bob.id, carol.id, alice.id],
    });
    const id = (done as { result: { id: string } }).result.id;
    const expense = await expenseOf(id, alice.token);
    expect(expense).toMatchObject({ amount: 955, original: { currency: 'CHF', amount: 1000, rate: '0.9545' } });
    // Bob is listed first, so the remainder of 1 goes to his share.
    expect((expense.shares as { memberId: string; amount: number }[]).map(share => share.amount)).toEqual([
      319, 318, 318,
    ]);
  });

  it('keeps the rate as the string the payer gave, whatever its digits: "1", "12.5" and "0.9542" read back as written', async () => {
    const { alice, bob, groupId } = await twoMembers();
    for (const rate of ['1', '12.5', '0.9542']) {
      const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
        description: `At ${rate}`,
        original: { currency: 'GBP', amount: 100, rate },
        date: today(),
        splitBetween: [bob.id, alice.id],
      });
      const id = (done as { result: { id: string } }).result.id;
      expect((await expenseOf(id, alice.token)).original).toEqual({ currency: 'GBP', amount: 100, rate });
    }
  });

  it('reads an expense in the group’s own currency as before, with no original', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Groceries',
      amount: 1000,
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    const id = (done as { result: { id: string } }).result.id;
    const expense = await expenseOf(id, alice.token);
    expect(expense).not.toHaveProperty('original');
    expect(expense).toMatchObject({ amount: 1000 });
  });

  it('counts the converted amount in the balances: Alice paid 1311 for two, so she is owed 655', async () => {
    const { alice, bob, groupId } = await twoMembers();
    await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Dinner in Zurich',
      original: { currency: 'USD', amount: 1234, rate: '1.0625' },
      date: today(),
      splitBetween: [alice.id, bob.id],
    });
    const { body } = await http.get(`${api}/groups/${groupId}/balances`, { token: alice.token });
    expect(body).toEqual([
      { memberId: alice.id, balance: 655 },
      { memberId: bob.id, balance: -655 },
    ]);
    const { body: listed } = await http.get(`${api}/groups/${groupId}/expenses`, { token: alice.token });
    expect((listed as Body[])[0]).toMatchObject({ amount: 1311, original: { currency: 'USD', amount: 1234 } });
  });

  it.each([
    ['the group’s own currency', { currency: 'EUR', amount: 10, rate: '1' }, 'SameCurrencyAsGroup'],
    ['a currency that is not Tally’s', { currency: 'XXX', amount: 10, rate: '1' }, 'InvalidOriginalCurrency'],
    ['a rate of 0', { currency: 'USD', amount: 10, rate: '0' }, 'InvalidRate'],
    ['a rate with seven digits after the point', { currency: 'USD', amount: 10, rate: '1.0000001' }, 'InvalidRate'],
    ['a rate that is not a decimal number', { currency: 'USD', amount: 10, rate: '1e3' }, 'InvalidRate'],
    ['an amount of 0', { currency: 'USD', amount: 0, rate: '1' }, 'InvalidOriginalAmount'],
    ['a converted amount below 1', { currency: 'USD', amount: 1, rate: '0.4' }, 'InvalidAmount'],
  ])('refuses %s behind the 202, by name', async (_, original, type) => {
    const { alice, bob, groupId } = await twoMembers();
    const { answer, done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Refused',
      original,
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'ERROR', error: { type, message: expect.any(String) } });
  });

  it.each([
    ['both an amount and an original', { amount: 10, original: { currency: 'USD', amount: 10, rate: '1' } }],
    ['neither', {}],
    ['a rate that is a number, not a string', { original: { currency: 'USD', amount: 10, rate: 1.5 } }],
  ])('refuses %s at once with 400', async (_, amountFields) => {
    const { alice, bob, groupId } = await twoMembers();
    const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Shape', date: today(), splitBetween: [bob.id, alice.id], ...amountFields },
      token: alice.token,
    });
    expect(answer.status).toBe(400);
  });

  // Request 22: the rate may be left out; with no rates service configured (none here), no rate is offered, so it is refused.
  it('refuses an original whose rate is left out, by name, when no rate is offered (request 22)', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { answer, done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'No rate',
      original: { currency: 'USD', amount: 10 },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NoRateOffered' } });
  });
});

describe('editing an expense in another currency', () => {
  it('gives it again in the group’s currency: no original is kept, and the amount is the one given', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Dinner',
      original: { currency: 'USD', amount: 1234, rate: '1.0625' },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    const id = (done as { result: { id: string } }).result.id;
    const before = await expenseOf(id, alice.token);

    const edited = await send('PUT', `/expenses/${id}`, alice.token, {
      description: 'Dinner',
      amount: 900,
      date: today(),
      version: before.version,
      splitBetween: [bob.id, alice.id],
    });
    expect(edited.done).toMatchObject({ status: 'SUCCESS' });
    const after = await expenseOf(id, alice.token);
    expect(after).toMatchObject({ amount: 900, version: (before.version as number) + 1 });
    expect(after).not.toHaveProperty('original');
  });

  it('gives it again in another currency, at the rate given: the original and the amount change together', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Dinner',
      amount: 900,
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    const id = (done as { result: { id: string } }).result.id;
    const before = await expenseOf(id, alice.token);

    const edited = await send('PUT', `/expenses/${id}`, alice.token, {
      description: 'Dinner',
      original: { currency: 'AUD', amount: 2000, rate: '0.6' },
      date: today(),
      version: before.version,
      splitBetween: [bob.id, alice.id],
    });
    expect(edited.done).toMatchObject({ status: 'SUCCESS' });
    expect(await expenseOf(id, alice.token)).toMatchObject({
      amount: 1200,
      original: { currency: 'AUD', amount: 2000, rate: '0.6' },
    });
  });
});

describe('Groups → Ledger (GroupCurrency)', () => {
  it('records an expense in the group Groups made, read under the id that group was answered, and converts it into that group’s currency', async () => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const groupId = await createGroup(alice, 'CHF');
    await join(groupId, alice, bob);

    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Hotel',
      original: { currency: 'USD', amount: 1000, rate: '0.9' },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    const id = (done as { result: { id: string } }).result.id;
    const expense = await expenseOf(id, alice.token);
    expect(expense).toMatchObject({
      id,
      groupId,
      amount: 900,
      original: { currency: 'USD', amount: 1000, rate: '0.9' },
    });
  });

  it("refuses an expense in the group's own currency given as another one: Ledger reads the currency Groups made the group in", async () => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const groupId = await createGroup(alice, 'USD');
    await join(groupId, alice, bob);

    const { done } = await send('POST', `/groups/${groupId}/expenses`, alice.token, {
      description: 'Hotel',
      original: { currency: 'USD', amount: 1000, rate: '1' },
      date: today(),
      splitBetween: [bob.id, alice.id],
    });
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'SameCurrencyAsGroup' } });
  });
});
