import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('nettings');

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
const PAST = '2026-01-15';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group in the currency, with its owner as first member, and each given account joined by an invitation, in that order. */
async function groupWith(
  owner: { token: string },
  joiners: Array<{ token: string }>,
  currency = 'EUR',
): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Group', currency },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  for (const joiner of joiners) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const record = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const net = (token: string, body: unknown) => http.request('POST', `${api}/nettings`, { body, token });
const readNetting = (token: string, id: string) => http.request('GET', `${api}/nettings/${id}`, { token });
const readBalances = (groupId: string, token: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });

describe('a netting across groups', () => {
  it('nets what two people owe each other across their groups, as settlements that count at once (request 32 example)', async () => {
    const ann = await signedIn('net-ann@example.com', 'Ann');
    const bob = await signedIn('net-bob@example.com', 'Bob');
    const cy = await signedIn('net-cy@example.com', 'Cy');

    // Ann owes Bob 300 in the flat, and 200 in the trip, created later. Bob owes Ann 400 in the club, created last.
    const flat = await groupWith(ann, [bob]);
    expect(
      (
        await record(bob.token, flat, {
          description: 'Rent',
          amount: 600,
          date: PAST,
          splitExactly: [
            { memberId: bob.id, amount: 300 },
            { memberId: ann.id, amount: 300 },
          ],
        })
      ).status,
    ).toBe(201);
    const trip = await groupWith(ann, [bob]);
    expect(
      (
        await record(bob.token, trip, {
          description: 'Train',
          amount: 400,
          date: PAST,
          splitExactly: [
            { memberId: bob.id, amount: 200 },
            { memberId: ann.id, amount: 200 },
          ],
        })
      ).status,
    ).toBe(201);
    const club = await groupWith(ann, [bob]);
    expect(
      (
        await record(ann.token, club, {
          description: 'Climbing',
          amount: 800,
          date: PAST,
          splitExactly: [
            { memberId: ann.id, amount: 400 },
            { memberId: bob.id, amount: 400 },
          ],
        })
      ).status,
    ).toBe(201);

    const made = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(made.status).toBe(201);
    const nettingId = (made.body as { id: string }).id;

    // Read by the two people, the same; to anyone else it does not exist.
    const read = await readNetting(ann.token, nettingId);
    expect(read.status).toBe(200);
    const netting = read.body as {
      id: string;
      by: string;
      with: string;
      currency: string;
      amount: number;
      settlements: string[];
    };
    expect(netting).toMatchObject({ id: nettingId, by: ann.id, with: bob.id, currency: 'EUR', amount: 400 });
    expect(netting.settlements).toHaveLength(3);
    expect((await readNetting(bob.token, nettingId)).body).toEqual(netting);
    expect((await readNetting(cy.token, nettingId)).status).toBe(404);

    // The settlements in the order made: Ann pays Bob 300 in the flat and 100 in the trip; Bob pays Ann 400 in the club.
    const settlements = await Promise.all(
      netting.settlements.map(id => http.request('GET', `${api}/settlements/${id}`, { token: ann.token })),
    );
    expect(settlements.map(each => each.body)).toMatchObject([
      { groupId: flat, from: ann.id, to: bob.id, amount: 300, method: 'net', status: 'paid' },
      { groupId: trip, from: ann.id, to: bob.id, amount: 100, method: 'net', status: 'paid' },
      { groupId: club, from: bob.id, to: ann.id, amount: 400, method: 'net', status: 'paid' },
    ]);

    // They count at once: the balances are what the netting left, and the statement names it.
    expect((await readBalances(flat, ann.token)).body).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
    expect((await readBalances(trip, ann.token)).body).toEqual([
      { memberId: ann.id, balance: -100 },
      { memberId: bob.id, balance: 100 },
    ]);
    const statement = await http.request('GET', `${api}/groups/${trip}/members/${ann.id}/statement`, {
      token: ann.token,
    });
    expect(statement.body).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: 'settlement', description: 'Settlement by netting', paid: 100 }),
      ]),
    });

    // The audit: each settlement is a change of money by the member who asked.
    const audit = await http.request('GET', `${api}/groups/${club}/audit`, { token: ann.token });
    expect(audit.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'settlement-paid',
          by: ann.id,
          subjectId: netting.settlements[2],
          amount: 400,
        }),
      ]),
    );

    // Once netted, there is nothing left to net the other way: refused by name, and nothing changes.
    const again = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({ type: 'NothingToNet' });
    expect((await readNetting(ann.token, nettingId)).body).toEqual(netting);
  });

  it('refuses a netting with oneself, in a currency that is not one of Tally, and with someone with nothing to net', async () => {
    const ann = await signedIn('net-refuse-ann@example.com', 'Ann');
    const bob = await signedIn('net-refuse-bob@example.com', 'Bob');
    const dan = await signedIn('net-refuse-dan@example.com', 'Dan');
    await groupWith(ann, [bob]);

    expect((await net(ann.token, { with: ann.id, currency: 'EUR' })).body).toMatchObject({ type: 'NettingWithSelf' });
    expect((await net(ann.token, { with: bob.id, currency: 'XXX' })).body).toMatchObject({
      type: 'UnsupportedNettingCurrency',
    });
    expect((await net(ann.token, { with: dan.id, currency: 'EUR' })).body).toMatchObject({ type: 'NothingToNet' });
    expect((await net(ann.token, { with: bob.id, currency: 'EUR' })).body).toMatchObject({ type: 'NothingToNet' });
  });

  it('asks for a signed-in caller and the body shape', async () => {
    const ann = await signedIn('net-shape-ann@example.com', 'Ann');
    expect((await http.request('POST', `${api}/nettings`, { body: { with: ann.id, currency: 'EUR' } })).status).toBe(
      401,
    );
    expect((await net(ann.token, { currency: 'EUR' })).status).toBe(400);
    expect((await readNetting(ann.token, 'no-such-netting')).status).toBe(404);
  });
});

/**
 * Two groups of Ann and Bob, in the currency: in the first, Ann owes Bob 100 (Bob paid 200, split equally); in the second, created
 * later, Bob owes Ann 30 (Ann paid 60, split equally). Balances are net within a group, so the two debts are in two groups.
 */
async function owingEachOther(ann: { token: string; id: string }, bob: { token: string; id: string }) {
  const first = await groupWith(ann, [bob]);
  await record(bob.token, first, {
    description: 'Shop',
    amount: 200,
    date: PAST,
    splitExactly: [
      { memberId: bob.id, amount: 100 },
      { memberId: ann.id, amount: 100 },
    ],
  });
  const second = await groupWith(ann, [bob]);
  await record(ann.token, second, {
    description: 'Books',
    amount: 60,
    date: PAST,
    splitExactly: [
      { memberId: ann.id, amount: 30 },
      { memberId: bob.id, amount: 30 },
    ],
  });
  return { first, second };
}

describe('Groups → Settlements', () => {
  it('nets in the group Groups answered for, and finds its settlement by the group id POST /groups answered', async () => {
    const ann = await signedIn('rel-gs-ann@example.com', 'Ann');
    const bob = await signedIn('rel-gs-bob@example.com', 'Bob');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ann.token,
    });
    const groupId = (created.body as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });
    await record(bob.token, groupId, {
      description: 'Shop',
      amount: 200,
      date: PAST,
      splitExactly: [
        { memberId: bob.id, amount: 100 },
        { memberId: ann.id, amount: 100 },
      ],
    });
    const second = await groupWith(ann, [bob]);
    await record(ann.token, second, {
      description: 'Books',
      amount: 60,
      date: PAST,
      splitExactly: [
        { memberId: ann.id, amount: 30 },
        { memberId: bob.id, amount: 30 },
      ],
    });

    const made = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(made.status).toBe(201);
    const netting = (await readNetting(ann.token, (made.body as { id: string }).id)).body as { settlements: string[] };
    const settlement = await http.request('GET', `${api}/settlements/${netting.settlements[0]}`, { token: bob.token });
    expect(settlement.body).toMatchObject({
      groupId,
      from: ann.id,
      to: bob.id,
      amount: 30,
      method: 'net',
      status: 'paid',
    });
  });
});

describe('Ledger → Settlements', () => {
  it('nets what the expenses of Ledger left owed, and lists the settlement in the group it was made in', async () => {
    const ann = await signedIn('rel-ls-ann@example.com', 'Ann');
    const bob = await signedIn('rel-ls-bob@example.com', 'Bob');
    const { first, second } = await owingEachOther(ann, bob);

    const made = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(made.status).toBe(201);
    const listed = await http.request('GET', `${api}/groups/${first}/settlements`, { token: ann.token });
    expect(listed.body).toEqual([
      expect.objectContaining({ groupId: first, from: ann.id, to: bob.id, amount: 30, method: 'net', status: 'paid' }),
    ]);
    expect((await readBalances(first, ann.token)).body).toEqual([
      { memberId: ann.id, balance: -70 },
      { memberId: bob.id, balance: 70 },
    ]);
    expect((await readBalances(second, ann.token)).body).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
  });
});

describe('Settlements → Ledger', () => {
  it('makes the netting, and finds its settlement in the audit Ledger keeps by the settlement id', async () => {
    const ann = await signedIn('rel-sl-ann@example.com', 'Ann');
    const bob = await signedIn('rel-sl-bob@example.com', 'Bob');
    const { first } = await owingEachOther(ann, bob);

    const made = await net(ann.token, { with: bob.id, currency: 'EUR' });
    const netting = (await readNetting(ann.token, (made.body as { id: string }).id)).body as { settlements: string[] };
    const audit = await http.request('GET', `${api}/groups/${first}/audit`, { token: bob.token });
    expect(audit.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'settlement-paid',
          by: ann.id,
          subjectId: netting.settlements[0],
          amount: 30,
        }),
      ]),
    );
  });
});
