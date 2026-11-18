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
type Transfer = { from: string; to: string; amount: number };

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

/** Records an expense paid by the token's member, split equally, and follows its operation. */
async function record(
  token: string,
  groupId: string,
  body: { description: string; amount: number; date: string; splitBetween: string[] },
): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Reads the suggested settlements of a group, as the given token reads them. */
async function suggested(token: string | undefined, groupId: string): Promise<{ status: number; body: unknown }> {
  return http.get(`${api}/groups/${groupId}/settlements/suggested`, { token });
}

/** Reads the balances of a group, as the given member reads them. */
async function balances(token: string, groupId: string): Promise<{ status: number; body: unknown }> {
  return http.get(`${api}/groups/${groupId}/balances`, { token });
}

/** A day long past, which every expense may be spent on. */
const PAST_DAY = '2026-03-10';

describe('suggested settlements', () => {
  it('suggests the transfers of the request, in the order made: the most owing pays the most owed, ties to whoever joined first', async () => {
    const ann = await signedIn('set-ann@example.com', 'Ann');
    const bob = await signedIn('set-bob@example.com', 'Bob');
    const cy = await signedIn('set-cy@example.com', 'Cy');
    const dan = await signedIn('set-dan@example.com', 'Dan');
    const groupId = await createGroup(ann.token, 'Trip');
    await join(ann.token, groupId, bob.token);
    await join(ann.token, groupId, cy.token);
    await join(ann.token, groupId, dan.token);

    // Balances: Ann 500, Bob 100, Cy -300, Dan -300 (Cy and Dan joined in that order).
    expect(
      await record(ann.token, groupId, {
        description: 'Hotel',
        amount: 600,
        date: PAST_DAY,
        splitBetween: [ann.id, cy.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(
      await record(ann.token, groupId, {
        description: 'Taxi',
        amount: 400,
        date: PAST_DAY,
        splitBetween: [ann.id, dan.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(
      await record(bob.token, groupId, {
        description: 'Lunch',
        amount: 200,
        date: PAST_DAY,
        splitBetween: [bob.id, dan.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(await balances(dan.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 500 },
        { memberId: bob.id, balance: 100 },
        { memberId: cy.id, balance: -300 },
        { memberId: dan.id, balance: -300 },
      ],
    });

    const read = await suggested(bob.token, groupId);

    expect(read.status).toBe(200);
    expect(read.body).toEqual<Transfer[]>([
      { from: cy.id, to: ann.id, amount: 300 },
      { from: dan.id, to: ann.id, amount: 200 },
      { from: dan.id, to: bob.id, amount: 100 },
    ]);
  });

  it('suggests nothing when every balance is 0, and reading it records nothing', async () => {
    const ann = await signedIn('set-even-ann@example.com', 'Ann');
    const bob = await signedIn('set-even-bob@example.com', 'Bob');
    const groupId = await createGroup(ann.token, 'Even');
    await join(ann.token, groupId, bob.token);

    expect(await suggested(bob.token, groupId)).toMatchObject({ status: 200, body: [] });

    // An expense that is then split between both members, and paid back in the same amount: the balances stay even.
    expect(
      await record(ann.token, groupId, {
        description: 'Coffee',
        amount: 100,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(await suggested(ann.token, groupId)).toMatchObject({
      status: 200,
      body: [{ from: bob.id, to: ann.id, amount: 50 }],
    });

    // Reading the suggestion again changes nothing: the same transfers, and the balances as the expenses left them.
    expect(await suggested(ann.token, groupId)).toMatchObject({
      status: 200,
      body: [{ from: bob.id, to: ann.id, amount: 50 }],
    });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 50 },
        { memberId: bob.id, balance: -50 },
      ],
    });
  });

  it('refuses a stranger as if the group did not exist, and an anonymous caller with 401', async () => {
    const ann = await signedIn('set-private-ann@example.com', 'Ann');
    const stranger = await signedIn('set-stranger@example.com', 'Stranger');
    const groupId = await createGroup(ann.token, 'Private');

    expect(await suggested(stranger.token, groupId)).toMatchObject({ status: 404 });
    expect(await suggested(undefined, groupId)).toMatchObject({ status: 401 });
  });
});

describe('Groups → Settlements', () => {
  it('finds a member who joined through the API by the account id its sign-up answered, in the order they joined', async () => {
    const ann = await signedIn('gs-ann@example.com', 'Ann');
    const bob = await signedIn('gs-bob@example.com', 'Bob');
    const cy = await signedIn('gs-cy@example.com', 'Cy');
    const groupId = await createGroup(ann.token, 'Joiners');
    await join(ann.token, groupId, bob.token);
    await join(ann.token, groupId, cy.token);

    // Ann pays 300, split three ways: Bob and Cy each owe 100 of it.
    expect(
      await record(ann.token, groupId, {
        description: 'Dinner',
        amount: 300,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id, cy.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    // Bob and Cy owe the same, so the one who joined first (Bob) pays first; the ids are the sign-ups' own.
    expect(await suggested(ann.token, groupId)).toMatchObject({
      status: 200,
      body: [
        { from: bob.id, to: ann.id, amount: 100 },
        { from: cy.id, to: ann.id, amount: 100 },
      ],
    });
  });
});

describe('Ledger → Settlements', () => {
  it('reads the balance an expense made through the API leaves, and finds the expense by the id its request answered', async () => {
    const ann = await signedIn('ls-ann@example.com', 'Ann');
    const bob = await signedIn('ls-bob@example.com', 'Bob');
    const groupId = await createGroup(ann.token, 'Ledger');
    await join(ann.token, groupId, bob.token);

    const recorded = await record(ann.token, groupId, {
      description: 'Museum',
      amount: 100,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    expect(recorded).toMatchObject({ status: 'SUCCESS' });
    const expenseId = recorded.result as string;

    // The expense is there under the id its request answered (the operation's result).
    expect(await http.get(`${api}/expenses/${expenseId}`, { token: ann.token })).toMatchObject({
      status: 200,
      body: { id: expenseId, amount: 100, paidBy: ann.id },
    });
    // Settlements reads what that expense left: Bob owes Ann his half, from the members the expense named.
    expect(await suggested(bob.token, groupId)).toMatchObject({
      status: 200,
      body: [{ from: bob.id, to: ann.id, amount: 50 }],
    });
  });
});

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Records a payment in cash the token's member received from `from`, and follows its operation. */
async function settle(token: string, groupId: string, body: { from: string; amount: number }): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

describe('settle in cash (request 12)', () => {
  it('records a payment the payee received, counts it in the balances at once, and reads it back to a member only', async () => {
    const ann = await signedIn('sc-ann@example.com', 'Ann');
    const bob = await signedIn('sc-bob@example.com', 'Bob');
    const stranger = await signedIn('sc-stranger@example.com', 'Stranger');
    const groupId = await createGroup(ann.token, 'Cash');
    await join(ann.token, groupId, bob.token);
    expect(
      await record(ann.token, groupId, {
        description: 'Dinner',
        amount: 60,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 30 },
        { memberId: bob.id, balance: -30 },
      ],
    });

    const recorded = await settle(ann.token, groupId, { from: bob.id, amount: 30 });
    expect(recorded).toMatchObject({ status: 'SUCCESS' });
    const settlementId = recorded.result as string;

    expect(await balances(bob.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: bob.token })).toMatchObject({
      status: 200,
      body: {
        id: settlementId,
        groupId,
        from: bob.id,
        to: ann.id,
        amount: 30,
        method: 'cash',
        status: 'paid',
        at: expect.stringMatching(ISO_TIME),
      },
    });
    expect(await suggested(bob.token, groupId)).toMatchObject({ status: 200, body: [] });
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: stranger.token })).toMatchObject({
      status: 404,
    });
    expect(await http.get(`${api}/settlements/${settlementId}`)).toMatchObject({ status: 401 });
  });

  it('counts a settlement in the balance a member leaves with, and lists it in the statement beside the expenses', async () => {
    const ann = await signedIn('sc-leave-ann@example.com', 'Ann');
    const bob = await signedIn('sc-leave-bob@example.com', 'Bob');
    const groupId = await createGroup(ann.token, 'Leaving');
    await join(ann.token, groupId, bob.token);
    await record(ann.token, groupId, {
      description: 'Taxi',
      amount: 40,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });

    const leaveAnswer = async () => {
      const answer = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
      return answer.status === 202
        ? outcome((answer.body as { operationId: string }).operationId, bob.token)
        : ({ status: `HTTP ${answer.status}` } as Operation);
    };
    expect(await settle(ann.token, groupId, { from: bob.id, amount: 20 })).toMatchObject({ status: 'SUCCESS' });
    expect(await http.get(`${api}/groups/${groupId}/members/${bob.id}/statement`, { token: bob.token })).toMatchObject({
      status: 200,
      body: {
        memberId: bob.id,
        balance: 0,
        entries: [
          { kind: 'expense', description: 'Taxi', paid: 0, share: 20, balance: -20 },
          { kind: 'settlement', description: 'Settlement in cash', paid: 20, share: 0, balance: 0 },
        ],
      },
    });

    // Bob's settlement is counted in his balance, which is 0 now: leaving passes nothing, and Ann's balance is 0 too.
    expect(await leaveAnswer()).toMatchObject({ status: 'SUCCESS' });
    expect((await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token })).body).toEqual([
      { memberId: ann.id, balance: 0 },
    ]);
  });

  it('refuses a settlement that is not owed, or not for a member, and changes nothing', async () => {
    const ann = await signedIn('sc-refuse-ann@example.com', 'Ann');
    const bob = await signedIn('sc-refuse-bob@example.com', 'Bob');
    const stranger = await signedIn('sc-refuse-stranger@example.com', 'Stranger');
    const groupId = await createGroup(ann.token, 'Refusals');
    await join(ann.token, groupId, bob.token);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });

    expect(await settle(ann.token, groupId, { from: bob.id, amount: 31 })).toMatchObject({
      status: 'ERROR',
      error: { type: 'ExceedsWhatIsOwed' },
    });
    expect(await settle(ann.token, groupId, { from: bob.id, amount: 0 })).toMatchObject({
      status: 'ERROR',
      error: { type: 'InvalidSettlementAmount' },
    });
    expect(await settle(ann.token, groupId, { from: stranger.id, amount: 5 })).toMatchObject({
      status: 'ERROR',
      error: { type: 'PayerNotAMember' },
    });
    expect(await settle(ann.token, groupId, { from: ann.id, amount: 5 })).toMatchObject({
      status: 'ERROR',
      error: { type: 'PaidToSelf' },
    });
    expect(await settle(stranger.token, groupId, { from: bob.id, amount: 5 })).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotFound' },
    });
    expect(
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { body: { from: bob.id, amount: 5 } }),
    ).toMatchObject({ status: 401 });

    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 30 },
        { memberId: bob.id, balance: -30 },
      ],
    });
  });

  it('refuses more than the payee is owed, though the payer owes that much', async () => {
    const ann = await signedIn('sc-payee-ann@example.com', 'Ann');
    const bob = await signedIn('sc-payee-bob@example.com', 'Bob');
    const cy = await signedIn('sc-payee-cy@example.com', 'Cy');
    const dan = await signedIn('sc-payee-dan@example.com', 'Dan');
    const groupId = await createGroup(ann.token, 'Payee');
    await join(ann.token, groupId, bob.token);
    await join(ann.token, groupId, cy.token);
    await join(ann.token, groupId, dan.token);
    // Cy paid 90 for Cy, Ann and Bob: Cy is owed 60. Dan paid 200 for Dan and Ann: Ann owes 130 in all.
    await record(cy.token, groupId, {
      description: 'Hotel',
      amount: 90,
      date: PAST_DAY,
      splitBetween: [cy.id, ann.id, bob.id],
    });
    await record(dan.token, groupId, {
      description: 'Car',
      amount: 200,
      date: PAST_DAY,
      splitBetween: [dan.id, ann.id],
    });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: -130 },
        { memberId: bob.id, balance: -30 },
        { memberId: cy.id, balance: 60 },
        { memberId: dan.id, balance: 100 },
      ],
    });

    expect(await settle(cy.token, groupId, { from: ann.id, amount: 70 })).toMatchObject({
      status: 'ERROR',
      error: { type: 'ExceedsWhatIsOwedToPayee' },
    });
    expect(await settle(cy.token, groupId, { from: ann.id, amount: 60 })).toMatchObject({ status: 'SUCCESS' });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: -70 },
        { memberId: bob.id, balance: -30 },
        { memberId: cy.id, balance: 0 },
        { memberId: dan.id, balance: 100 },
      ],
    });
  });

  it('decides two settlements at the same moment one after the other: the second meets the rule', async () => {
    const ann = await signedIn('sc-race-ann@example.com', 'Ann');
    const bob = await signedIn('sc-race-bob@example.com', 'Bob');
    const groupId = await createGroup(ann.token, 'Race');
    await join(ann.token, groupId, bob.token);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });

    const [first, second] = await Promise.all([
      settle(ann.token, groupId, { from: bob.id, amount: 30 }),
      settle(ann.token, groupId, { from: bob.id, amount: 30 }),
    ]);
    expect([first.status, second.status].sort()).toEqual(['ERROR', 'SUCCESS']);
    expect([first, second].find(operation => operation.status === 'ERROR')).toMatchObject({
      error: { type: 'ExceedsWhatIsOwed' },
    });
    expect(await balances(ann.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });
  });
});

// The two contexts keep their tables in one PostgreSQL database (ADR 21): the id a request answered still finds the thing across them.
describe('Settlements → Ledger (SettledAmounts)', () => {
  it('makes a settlement through the API, keeps the id its operation answered, and finds it there after Ledger reads it', async () => {
    const ann = await signedIn('sl-ann@example.com', 'Ann');
    const bob = await signedIn('sl-bob@example.com', 'Bob');
    const groupId = await createGroup(ann.token, 'Ledger reads');
    await join(ann.token, groupId, bob.token);
    await record(ann.token, groupId, {
      description: 'Bread',
      amount: 50,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });

    const recorded = await settle(ann.token, groupId, { from: bob.id, amount: 25 });
    expect(recorded).toMatchObject({ status: 'SUCCESS' });
    const settlementId = recorded.result as string;

    // Ledger reads the balances, which count the settlement by the id it was recorded under.
    expect(await balances(bob.token, groupId)).toMatchObject({
      body: [
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });
    expect(await http.get(`${api}/settlements/${settlementId}`, { token: ann.token })).toMatchObject({
      status: 200,
      body: { id: settlementId, from: bob.id, to: ann.id, amount: 25 },
    });
  });
});
