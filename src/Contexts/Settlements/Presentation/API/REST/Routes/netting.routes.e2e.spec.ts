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

/** Creates a group in the currency given and follows its operation: the operation's result is the group's id. */
async function createGroup(token: string, name: string, currency = 'EUR'): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** Joins a group by an invitation, following the operation of the join. */
async function join(token: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: joiner });
  await outcome((accepted.body as { operationId: string }).operationId, joiner);
}

/** Records an expense paid by the token's member, split between the members given, and follows its operation. */
async function record(
  token: string,
  groupId: string,
  body: { description: string; amount: number; date: string; splitBetween: string[] },
): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Asks for a netting as the token's member, and follows its operation: the operation's result is the netting's id. */
async function net(token: string, body: { with: string; currency: string }): Promise<Operation> {
  const answer = await http.request('POST', `${api}/nettings`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** A day long past, which every expense may be spent on. */
const PAST_DAY = '2026-03-10';

describe('netting what two people owe each other across their groups', () => {
  it('nets the smaller total into settlements that count at once, and reads them to the two people only', async () => {
    const ann = await signedIn('net-ann@example.com', 'Ann');
    const bob = await signedIn('net-bob@example.com', 'Bob');
    const cy = await signedIn('net-cy@example.com', 'Cy');
    // Created in this order: the flat, the trip, then the club (the earliest first).
    const flat = await createGroup(ann.token, 'Flat');
    await join(ann.token, flat, bob.token);
    const trip = await createGroup(ann.token, 'Trip');
    await join(ann.token, trip, bob.token);
    const club = await createGroup(bob.token, 'Club');
    await join(bob.token, club, ann.token);

    // Ann owes Bob 300 in the flat and 200 in the trip; Bob owes Ann 400 in the club.
    expect(
      await record(bob.token, flat, {
        description: 'Rent',
        amount: 600,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(
      await record(bob.token, trip, {
        description: 'Train',
        amount: 400,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(
      await record(ann.token, club, {
        description: 'Club',
        amount: 800,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    const netted = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(netted).toMatchObject({ status: 'SUCCESS' });
    const nettingId = netted.result as string;

    const read = await http.get(`${api}/nettings/${nettingId}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: nettingId, by: ann.id, with: bob.id, currency: 'EUR', amount: 400 });
    const settlementIds = (read.body as { settlements: string[] }).settlements;
    expect(settlementIds).toHaveLength(3);

    // The settlements, in the order made: Ann pays Bob 300 in the flat and 100 in the trip; Bob pays Ann 400 in the club.
    const settlements = [];
    for (const settlementId of settlementIds) {
      const settlement = await http.get(`${api}/settlements/${settlementId}`, { token: ann.token });
      settlements.push(settlement.body as { from: string; to: string; amount: number; method: string; status: string });
    }
    expect(settlements.map(({ from, to, amount, method, status }) => ({ from, to, amount, method, status }))).toEqual([
      { from: ann.id, to: bob.id, amount: 300, method: 'net', status: 'paid' },
      { from: ann.id, to: bob.id, amount: 100, method: 'net', status: 'paid' },
      { from: bob.id, to: ann.id, amount: 400, method: 'net', status: 'paid' },
    ]);

    // Counted at once: the balances of the flat and the club are 0, and the trip is down to 100 owed by Ann.
    expect(await http.get(`${api}/groups/${flat}/balances`, { token: ann.token })).toMatchObject({
      body: [
        { memberId: ann.id, balance: 0 },
        { memberId: bob.id, balance: 0 },
      ],
    });
    expect(await http.get(`${api}/groups/${trip}/balances`, { token: ann.token })).toMatchObject({
      body: [
        { memberId: ann.id, balance: -100 },
        { memberId: bob.id, balance: 100 },
      ],
    });

    // Nothing is left to net between them: a second netting is refused, and changes nothing.
    expect(await net(bob.token, { with: ann.id, currency: 'EUR' })).toMatchObject({
      status: 'ERROR',
      error: { type: 'NothingToNet' },
    });

    // To anyone else the netting does not exist.
    expect((await http.get(`${api}/nettings/${nettingId}`, { token: cy.token })).status).toBe(404);
  });

  it('refuses a netting with oneself, in a currency Tally does not keep, and between two with nothing to net', async () => {
    const dan = await signedIn('net-dan@example.com', 'Dan');
    const eve = await signedIn('net-eve@example.com', 'Eve');
    const group = await createGroup(dan.token, 'Solo');
    await join(dan.token, group, eve.token);

    expect(await net(dan.token, { with: dan.id, currency: 'EUR' })).toMatchObject({
      status: 'ERROR',
      error: { type: 'NettingWithSelf' },
    });
    expect(await net(dan.token, { with: eve.id, currency: 'XYZ' })).toMatchObject({
      status: 'ERROR',
      error: { type: 'CurrencyNotSupported' },
    });
    expect(await net(dan.token, { with: eve.id, currency: 'EUR' })).toMatchObject({
      status: 'ERROR',
      error: { type: 'NothingToNet' },
    });
  });
});

describe('Groups → Settlements (SettlementMembers)', () => {
  it('nets in a group Groups made through the API, and Settlements finds that group by the id the request answered', async () => {
    const ann = await signedIn('rel-gs-ann@example.com', 'Ann');
    const bob = await signedIn('rel-gs-bob@example.com', 'Bob');
    const flat = await createGroup(ann.token, 'Flat');
    await join(ann.token, flat, bob.token);
    const club = await createGroup(bob.token, 'Club');
    await join(bob.token, club, ann.token);

    expect(
      await record(bob.token, flat, {
        description: 'Rent',
        amount: 600,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(
      await record(ann.token, club, {
        description: 'Club',
        amount: 600,
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    const netted = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(netted).toMatchObject({ status: 'SUCCESS' });
    const netting = await http.get(`${api}/nettings/${netted.result}`, { token: ann.token });
    const settlementIds = (netting.body as { settlements: string[] }).settlements;
    const settlements = [];
    for (const settlementId of settlementIds) {
      settlements.push(
        (await http.get(`${api}/settlements/${settlementId}`, { token: ann.token })).body as { groupId: string },
      );
    }
    // The groups Settlements settles in are the ones Groups answered with, by the ids they answered.
    expect(settlements.map(settlement => settlement.groupId)).toEqual([flat, club]);
  });
});

describe('Ledger → Settlements (GroupBalances)', () => {
  it('nets the balance an expense Ledger recorded through the API leaves, and Settlements finds the expense by its id', async () => {
    const ann = await signedIn('rel-ls-ann@example.com', 'Ann');
    const bob = await signedIn('rel-ls-bob@example.com', 'Bob');
    const flat = await createGroup(ann.token, 'Flat');
    await join(ann.token, flat, bob.token);
    const club = await createGroup(bob.token, 'Club');
    await join(bob.token, club, ann.token);

    const expense = await record(bob.token, flat, {
      description: 'Rent',
      amount: 600,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    expect(expense).toMatchObject({ status: 'SUCCESS' });
    const expenseId = expense.result as string;
    await record(ann.token, club, { description: 'Club', amount: 600, date: PAST_DAY, splitBetween: [ann.id, bob.id] });

    const netted = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(netted).toMatchObject({ status: 'SUCCESS' });
    // Ledger holds the expense under the id its request answered; the netting settled the debt it left, in that group.
    expect((await http.get(`${api}/expenses/${expenseId}`, { token: ann.token })).body).toMatchObject({
      groupId: flat,
    });
    const netting = await http.get(`${api}/nettings/${netted.result}`, { token: ann.token });
    const first = (
      await http.get(`${api}/settlements/${(netting.body as { settlements: string[] }).settlements[0]}`, {
        token: ann.token,
      })
    ).body as { groupId: string; amount: number };
    expect(first).toMatchObject({ groupId: flat, amount: 300 });
  });
});

describe('Settlements → Ledger (SettledAmounts, SettlementAudit)', () => {
  it('nets in Settlements, and Ledger reads the settlement by the id it was made under, in the group audit', async () => {
    const ann = await signedIn('rel-sl-ann@example.com', 'Ann');
    const bob = await signedIn('rel-sl-bob@example.com', 'Bob');
    const flat = await createGroup(ann.token, 'Flat');
    await join(ann.token, flat, bob.token);
    const club = await createGroup(bob.token, 'Club');
    await join(bob.token, club, ann.token);
    await record(bob.token, flat, { description: 'Rent', amount: 600, date: PAST_DAY, splitBetween: [ann.id, bob.id] });
    await record(ann.token, club, { description: 'Club', amount: 600, date: PAST_DAY, splitBetween: [ann.id, bob.id] });

    const netted = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(netted).toMatchObject({ status: 'SUCCESS' });
    const netting = await http.get(`${api}/nettings/${netted.result}`, { token: ann.token });
    const settlementId = (netting.body as { settlements: string[] }).settlements[0];

    // Ledger reads Settlements' audit of the flat: the settlement netted there, by the member who asked, under its own id.
    const audit = await http.get(`${api}/groups/${flat}/audit`, { token: ann.token });
    expect(audit.status).toBe(200);
    expect(audit.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'settlement-paid', by: ann.id, subjectId: settlementId }),
      ]),
    );
  });
});
