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
