import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Settling up in cash, end to end (request 12): the application booted in this process, spoken to over HTTP, every answer
 * held to api/12-settle-in-cash.yaml by the client. One application per suite, shared by its tests in order.
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

async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  for (const other of others) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
    const invitationId = (invitation.body as { id: string }).id;
    expect((await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: other.token })).status).toBe(
      201,
    );
  }
  return groupId;
}

const settle = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/settlements/cash`, { body, token });
const balancesOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/balances`, { token })).body as { memberId: string; balance: number }[];

describe('a cash settlement', () => {
  it('is recorded by its payee, counted by the balances at once, and read by a member of the group', async () => {
    const ann = await accountOf('ann.cash@example.com', 'Ann');
    const bob = await accountOf('bob.cash@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    // Ann paid 60 for both of them: Bob owes Ann 30.
    const expense = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: SPENT, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    expect(expense.status).toBe(201);

    const recorded = await settle(groupId, ann.token, { from: bob.id, amount: 30 });
    expect(recorded.status).toBe(201);
    const id = (recorded.body as { id: string }).id;

    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);

    const read = await http.get(`/v1/settlements/${id}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      from: bob.id,
      to: ann.id,
      amount: 30,
      method: 'cash',
      status: 'paid',
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      // Request 19: a cash settlement is paid at once, so its history is that one line.
      history: [{ status: 'paid', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) }],
    });

    // A member's statement counts the settlement too (request 29): Bob's statement, which listed the expense he owes 30 on, now ends at 0.
    const statement = await http.get(`/v1/groups/${groupId}/members/${bob.id}/statement`, { token: bob.token });
    expect((statement.body as { balance: number }).balance).toBe(0);
  });

  it('is refused when it is more than the payer owes, and nothing changes', async () => {
    const ann = await accountOf('ann.over@example.com', 'Ann');
    const bob = await accountOf('bob.over@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: SPENT, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });

    const refused = await settle(groupId, ann.token, { from: bob.id, amount: 31 });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ type: 'SettlementExceedsBalance', message: expect.any(String) });
    expect((await balancesOf(groupId, ann.token)).find(b => b.memberId === bob.id)?.balance).toBe(-30);
  });

  it('is decided on the balances as the other left them: of two settlements at once, one is kept', async () => {
    const ann = await accountOf('ann.race@example.com', 'Ann');
    const bob = await accountOf('bob.race@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: SPENT, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });

    const [first, second] = await Promise.all([
      settle(groupId, ann.token, { from: bob.id, amount: 30 }),
      settle(groupId, ann.token, { from: bob.id, amount: 30 }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 400]);
    expect((await balancesOf(groupId, ann.token)).find(b => b.memberId === bob.id)?.balance).toBe(0);
  });

  it('is refused for a payer who is the payee, an amount under 1, or a payer who is not a member', async () => {
    const ann = await accountOf('ann.refuse@example.com', 'Ann');
    const bob = await accountOf('bob.refuse@example.com', 'Bob');
    const stranger = await accountOf('stranger.refuse@example.com', 'Stranger');
    const groupId = await groupWith(ann, [bob]);
    await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: SPENT, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });

    expect((await settle(groupId, ann.token, { from: ann.id, amount: 1 })).body).toMatchObject({
      type: 'SettlementToSelf',
    });
    expect((await settle(groupId, ann.token, { from: bob.id, amount: 0 })).body).toMatchObject({
      type: 'InvalidSettlementAmount',
    });
    expect((await settle(groupId, ann.token, { from: stranger.id, amount: 1 })).body).toMatchObject({
      type: 'SettlementPayerNotMember',
    });
  });

  it('is not found by someone outside the group, and a group the caller is not in does not exist', async () => {
    const ann = await accountOf('ann.outside@example.com', 'Ann');
    const bob = await accountOf('bob.outside@example.com', 'Bob');
    const outsider = await accountOf('outsider.outside@example.com', 'Outsider');
    const groupId = await groupWith(ann, [bob]);
    await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: SPENT, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    const id = ((await settle(groupId, ann.token, { from: bob.id, amount: 30 })).body as { id: string }).id;

    expect((await http.get(`/v1/settlements/${id}`, { token: outsider.token })).status).toBe(404);
    expect((await settle(groupId, outsider.token, { from: bob.id, amount: 30 })).status).toBe(404);
  });
});

describe('Groups → Settlements', () => {
  it('records a settlement in a group Groups made, and reads it back by the id it answered, with that group', async () => {
    const ann = await accountOf('ann.groups@example.com', 'Ann');
    const bob = await accountOf('bob.groups@example.com', 'Bob');
    // The group is made in Groups, and its id is the one its creation answered.
    const groupId = await groupWith(ann, [bob]);
    await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: SPENT, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });

    const recorded = await settle(groupId, ann.token, { from: bob.id, amount: 30 });
    expect(recorded.status).toBe(201);
    const read = await http.get(`/v1/settlements/${(recorded.body as { id: string }).id}`, { token: bob.token });
    expect((read.body as { groupId: string }).groupId).toBe(groupId);
  });
});

describe('Ledger → Settlements', () => {
  it('suggests, through Settlements, the transfers of an expense Ledger recorded, found by the id it answered', async () => {
    const ann = await accountOf('ann.ledger@example.com', 'Ann');
    const bob = await accountOf('bob.ledger@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    const expense = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: SPENT, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    const expenseId = (expense.body as { id: string }).id;

    // Ledger finds the expense by the id its recording answered; its group is the one Settlements suggests for.
    const found = await http.get(`/v1/expenses/${expenseId}`, { token: ann.token });
    const suggested = await http.get(
      `/v1/groups/${(found.body as { groupId: string }).groupId}/settlements/suggested`,
      {
        token: bob.token,
      },
    );
    expect(suggested.body).toEqual([{ from: bob.id, to: ann.id, amount: 30 }]);
  });
});

describe('Settlements → Ledger', () => {
  it('counts, through Ledger, a settlement Settlements recorded, found by the id it answered', async () => {
    const ann = await accountOf('ann.settled@example.com', 'Ann');
    const bob = await accountOf('bob.settled@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: SPENT, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    const recorded = await settle(groupId, ann.token, { from: bob.id, amount: 30 });
    const settlementId = (recorded.body as { id: string }).id;

    // Settlements finds the settlement by its id; Ledger's balances of the same group count it.
    const found = await http.get(`/v1/settlements/${settlementId}`, { token: ann.token });
    const counted = await balancesOf((found.body as { groupId: string }).groupId, ann.token);
    expect(counted.find(b => b.memberId === bob.id)?.balance).toBe(0);
  });
});
