import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Netting what two people owe each other across their groups, end to end (request 32): the application booted in this process,
 * spoken to over HTTP, every answer held to api/32-net-across-groups.yaml by the client. One application per suite.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';
const SPENT = '2020-01-02';

async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

async function groupWith(owner: { token: string }, other: { token: string }, currency = 'EUR'): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'A group', currency },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
  const invitationId = (invitation.body as { id: string }).id;
  expect((await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: other.token })).status).toBe(
    201,
  );
  return groupId;
}

/** Paid by `payer`, split equally between the two of them: the other owes the payer half of the amount. */
async function splitBetweenTwo(
  groupId: string,
  payer: { token: string; id: string },
  other: { id: string },
  amount: number,
) {
  const expense = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
    body: { description: 'Shared', amount, date: SPENT, splitBetween: [payer.id, other.id] },
    token: payer.token,
  });
  expect(expense.status).toBe(201);
}

const net = (token: string, body: unknown) => http.request('POST', '/v1/nettings', { body, token });
const balancesOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/balances`, { token })).body as { memberId: string; balance: number }[];

describe('netting what two people owe each other across their groups', () => {
  it('nets the smaller of the two totals, as settlements that count at once, in the order they were made', async () => {
    const ann = await accountOf('ann.netting@example.com', 'Ann');
    const bob = await accountOf('bob.netting@example.com', 'Bob');
    // Ann owes Bob 300 in the flat and 200 in the trip, created later; Bob owes Ann 400 in the club.
    const flat = await groupWith(bob, ann);
    await splitBetweenTwo(flat, bob, ann, 600);
    const trip = await groupWith(bob, ann);
    await splitBetweenTwo(trip, bob, ann, 400);
    const club = await groupWith(ann, bob);
    await splitBetweenTwo(club, ann, bob, 800);

    const netted = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(netted.status).toBe(201);
    const nettingId = (netted.body as { id: string }).id;

    const read = await http.get(`/v1/nettings/${nettingId}`, { token: ann.token });
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

    // Ann pays Bob 300 in the flat and 100 in the trip; Bob pays Ann 400 in the club. Each counts at once, by netting.
    const settlements = await Promise.all(
      netting.settlements.map(async id => (await http.get(`/v1/settlements/${id}`, { token: ann.token })).body),
    );
    expect(settlements).toMatchObject([
      { groupId: flat, from: ann.id, to: bob.id, amount: 300, method: 'net', status: 'paid' },
      { groupId: trip, from: ann.id, to: bob.id, amount: 100, method: 'net', status: 'paid' },
      { groupId: club, from: bob.id, to: ann.id, amount: 400, method: 'net', status: 'paid' },
    ]);

    // Their balances are what the settlements leave: Ann still owes 100 in the trip, and nothing else.
    expect(await balancesOf(flat, ann.token)).toEqual(expect.arrayContaining([{ memberId: ann.id, balance: 0 }]));
    expect(await balancesOf(trip, ann.token)).toEqual(expect.arrayContaining([{ memberId: ann.id, balance: -100 }]));
    expect(await balancesOf(club, ann.token)).toEqual(expect.arrayContaining([{ memberId: ann.id, balance: 0 }]));

    // The statement names them, and the audit records each as paid by the member who asked.
    const statement = await http.get(`/v1/groups/${flat}/members/${ann.id}/statement`, { token: ann.token });
    expect(statement.status).toBe(200);
    expect(
      (statement.body as { entries: { description: string }[] }).entries.map(entry => entry.description),
    ).toContain('Settlement by netting');
    const audit = (await http.get(`/v1/groups/${flat}/audit`, { token: ann.token })).body as {
      action: string;
      by: string;
      subjectId: string;
    }[];
    expect(audit).toContainEqual(
      expect.objectContaining({ action: 'settlement-paid', by: ann.id, subjectId: netting.settlements[0] }),
    );

    // Nothing is left to net: a second netting is refused, and changes nothing.
    const again = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ type: 'NothingToNet' });
    expect(await balancesOf(trip, ann.token)).toEqual(expect.arrayContaining([{ memberId: ann.id, balance: -100 }]));

    // A netted settlement is never refunded.
    const refund = await http.request('POST', `/v1/settlements/${netting.settlements[0]}/refund`, { token: bob.token });
    expect(refund.status).toBe(400);
    expect(refund.body).toMatchObject({ type: 'SettlementNotRefundable' });
  });

  it('refuses a netting with oneself, in a currency Tally does not count, or with nothing to net; and reads it to the two only', async () => {
    const ann = await accountOf('ann.refusals@example.com', 'Ann');
    const bob = await accountOf('bob.refusals@example.com', 'Bob');
    const carl = await accountOf('carl.refusals@example.com', 'Carl');
    // Ann owes Bob 300 in the flat, and Bob owes Ann 400 in the club: 300 can be netted.
    const flat = await groupWith(bob, ann);
    await splitBetweenTwo(flat, bob, ann, 600);
    const club = await groupWith(ann, bob);
    await splitBetweenTwo(club, ann, bob, 800);

    expect(await net(ann.token, { with: ann.id, currency: 'EUR' })).toMatchObject({
      status: 400,
      body: { type: 'NettingWithSelf' },
    });
    expect(await net(ann.token, { with: bob.id, currency: 'XYZ' })).toMatchObject({
      status: 400,
      body: { type: 'UnknownCurrency' },
    });
    expect(await net(ann.token, { with: carl.id, currency: 'EUR' })).toMatchObject({
      status: 400,
      body: { type: 'NothingToNet' },
    });

    const netted = await net(ann.token, { with: bob.id, currency: 'EUR' });
    expect(netted.status).toBe(201);
    const nettingId = (netted.body as { id: string }).id;
    expect((await http.get(`/v1/nettings/${nettingId}`, { token: bob.token })).status).toBe(200);
    expect((await http.get(`/v1/nettings/${nettingId}`, { token: carl.token })).status).toBe(404);
  });

  it('a netting asked twice at the same moment makes its settlements once: the second is refused, and nothing is paid past what is owed', async () => {
    const ann = await accountOf('ann.race@example.com', 'Ann');
    const bob = await accountOf('bob.race@example.com', 'Bob');
    // Ann owes Bob 300 in the flat, and Bob owes Ann 400 in the club: 300 is netted, once.
    const flat = await groupWith(bob, ann);
    await splitBetweenTwo(flat, bob, ann, 600);
    const club = await groupWith(ann, bob);
    await splitBetweenTwo(club, ann, bob, 800);

    const [first, second] = await Promise.all([
      net(ann.token, { with: bob.id, currency: 'EUR' }),
      net(ann.token, { with: bob.id, currency: 'EUR' }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 400]);
    const refused = first.status === 400 ? first : second;
    expect(refused.body).toMatchObject({ type: 'NothingToNet' });

    expect(await balancesOf(flat, ann.token)).toEqual(expect.arrayContaining([{ memberId: ann.id, balance: 0 }]));
    // 300 netted: Bob pays Ann 300 in the club, which leaves Ann owed 100 there.
    expect(await balancesOf(club, ann.token)).toEqual(expect.arrayContaining([{ memberId: ann.id, balance: 100 }]));
  });
});

describe('Groups → Settlements', () => {
  it('makes a group in Groups by the id its creation answered, and the netting in it is read in Settlements as settlements of that same group', async () => {
    const ann = await accountOf('ann.netting.groups@example.com', 'Ann');
    const bob = await accountOf('bob.netting.groups@example.com', 'Bob');
    const flat = await groupWith(bob, ann);
    await splitBetweenTwo(flat, bob, ann, 600);
    const club = await groupWith(ann, bob);
    await splitBetweenTwo(club, ann, bob, 800);

    const netted = await net(ann.token, { with: bob.id, currency: 'EUR' });
    const netting = (await http.get(`/v1/nettings/${(netted.body as { id: string }).id}`, { token: ann.token }))
      .body as { settlements: string[] };

    const settlement = await http.get(`/v1/settlements/${netting.settlements[0]}`, { token: ann.token });
    expect(settlement.status).toBe(200);
    expect(settlement.body).toMatchObject({ groupId: flat, method: 'net', status: 'paid' });
  });
});

describe('Ledger → Settlements', () => {
  it('records an expense in Ledger by the id it answered, and the netting that counts its balance pays that expense’s group by the amount it owes', async () => {
    const ann = await accountOf('ann.netting.ledger@example.com', 'Ann');
    const bob = await accountOf('bob.netting.ledger@example.com', 'Bob');
    const flat = await groupWith(bob, ann);
    const recorded = await http.request('POST', `/v1/groups/${flat}/expenses`, {
      body: { description: 'Shared', amount: 600, date: SPENT, splitBetween: [bob.id, ann.id] },
      token: bob.token,
    });
    const expenseId = (recorded.body as { id: string }).id;
    const club = await groupWith(ann, bob);
    await splitBetweenTwo(club, ann, bob, 800);

    const expense = await http.get(`/v1/expenses/${expenseId}`, { token: bob.token });
    expect((expense.body as { groupId: string }).groupId).toBe(flat);

    const netted = await net(ann.token, { with: bob.id, currency: 'EUR' });
    const netting = (await http.get(`/v1/nettings/${(netted.body as { id: string }).id}`, { token: ann.token }))
      .body as { amount: number; settlements: string[] };
    expect(netting.amount).toBe(300);

    const settlement = await http.get(`/v1/settlements/${netting.settlements[0]}`, { token: ann.token });
    expect(settlement.body).toMatchObject({ groupId: flat, from: ann.id, to: bob.id, amount: 300, method: 'net' });
  });
});

describe('Settlements → Ledger', () => {
  it('nets in Settlements by the id the netting answered, and Ledger shows each of its settlements in the statement by the same id', async () => {
    const ann = await accountOf('ann.netting.statement@example.com', 'Ann');
    const bob = await accountOf('bob.netting.statement@example.com', 'Bob');
    const flat = await groupWith(bob, ann);
    await splitBetweenTwo(flat, bob, ann, 600);
    const club = await groupWith(ann, bob);
    await splitBetweenTwo(club, ann, bob, 800);

    const netted = await net(ann.token, { with: bob.id, currency: 'EUR' });
    const nettingId = (netted.body as { id: string }).id;
    const netting = (await http.get(`/v1/nettings/${nettingId}`, { token: ann.token })).body as {
      settlements: string[];
    };

    const statement = await http.get(`/v1/groups/${flat}/members/${ann.id}/statement`, { token: ann.token });
    const entries = (statement.body as { entries: { kind: string; settlementId?: string; description: string }[] })
      .entries;
    expect(entries.filter(entry => entry.kind === 'settlement')).toEqual([
      expect.objectContaining({ settlementId: netting.settlements[0], description: 'Settlement by netting' }),
    ]);
  });
});
