import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Archiving a group, end to end (request 27): the application booted in this process on a free port, spoken to over HTTP,
 * every answer held to api/ by the client. One application per suite, shared by its tests in order.
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

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group founded by its owner, and a second account that joined it by an invitation. */
async function groupWith(owner: { token: string }, member: { token: string }, name: string): Promise<string> {
  const created = await http.request('POST', '/v1/groups', { body: { name, currency: 'EUR' }, token: owner.token });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: member.token });
  return groupId;
}

const archive = (groupId: string, token?: string) => http.request('POST', `/v1/groups/${groupId}/archive`, { token });
const getGroup = (groupId: string, token?: string) => http.get(`/v1/groups/${groupId}`, { token });
const leave = (groupId: string, token?: string) => http.request('POST', `/v1/groups/${groupId}/leave`, { token });
const invite = (groupId: string, token?: string) =>
  http.request('POST', `/v1/groups/${groupId}/invitations`, { token });
const balances = (groupId: string, token?: string) => http.get(`/v1/groups/${groupId}/balances`, { token });

/** An expense paid by `payer`, split exactly as given, answered as an operation. */
const recordExpense = (groupId: string, payer: string, split: { memberId: string; amount: number }[], amount: number) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, {
    token: payer,
    body: { description: 'Dinner', amount, date: '2026-01-10', splitExactly: split },
  });

const ARCHIVED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe('archiving a group', () => {
  it('lets the owner archive a group once every balance is 0, and then reads it as archived, when it was archived', async () => {
    const ana = await accountOf('ana.archive@example.com', 'Ana');
    const ben = await accountOf('ben.archive@example.com', 'Ben');
    const groupId = await groupWith(ana, ben, 'Trip to Lisbon');

    const before = (await getGroup(groupId, ana.token)).body as Record<string, unknown>;
    expect(before).not.toHaveProperty('archivedAt');

    const archived = await archive(groupId, ana.token);
    expect(archived.status).toBe(201);
    expect(archived.body).toEqual({ id: groupId });

    const after = (await getGroup(groupId, ben.token)).body as { archivedAt: string };
    expect(after.archivedAt).toMatch(ARCHIVED_AT);

    const mine = (await http.get('/v1/groups/mine', { token: ben.token })).body as {
      id: string;
      archivedAt?: string;
    }[];
    expect(mine.find(group => group.id === groupId)?.archivedAt).toBe(after.archivedAt);
  });

  it('refuses the archive while a member has a balance, and the group stays open', async () => {
    const ana = await accountOf('ana.unsettled@example.com', 'Ana');
    const ben = await accountOf('ben.unsettled@example.com', 'Ben');
    const groupId = await groupWith(ana, ben, 'Dinner club');

    const recorded = await recordExpense(
      groupId,
      ana.token,
      [
        { memberId: ana.id, amount: 50 },
        { memberId: ben.id, amount: 50 },
      ],
      100,
    );
    expect(recorded.status).toBe(201);

    const refused = await archive(groupId, ana.token);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ type: 'GroupNotSettled' });
    expect((await getGroup(groupId, ana.token)).body).not.toHaveProperty('archivedAt');
  });

  it('refuses the archive to a member who is not the owner, and to anyone who is not a member as if the group were not there', async () => {
    const ana = await accountOf('ana.owner@example.com', 'Ana');
    const ben = await accountOf('ben.owner@example.com', 'Ben');
    const cleo = await accountOf('cleo.owner@example.com', 'Cleo');
    const groupId = await groupWith(ana, ben, 'Flat');

    const byMember = await archive(groupId, ben.token);
    expect(byMember.status).toBe(403);
    expect(byMember.body).toMatchObject({ type: 'NotAllowed' });

    const byStranger = await archive(groupId, cleo.token);
    expect(byStranger.status).toBe(404);
    expect((await getGroup(groupId, ana.token)).body).not.toHaveProperty('archivedAt');
  });

  it('refuses every change in an archived group by GroupArchived, changes nothing, and keeps it readable', async () => {
    const ana = await accountOf('ana.frozen@example.com', 'Ana');
    const ben = await accountOf('ben.frozen@example.com', 'Ben');
    const groupId = await groupWith(ana, ben, 'Old trip');
    expect((await archive(groupId, ana.token)).status).toBe(201);

    const again = await archive(groupId, ana.token);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ type: 'GroupArchived' });

    const left = await leave(groupId, ben.token);
    expect(left.status).toBe(409);
    expect(left.body).toMatchObject({ type: 'GroupArchived' });

    const invited = await invite(groupId, ana.token);
    expect(invited.status).toBe(409);
    expect(invited.body).toMatchObject({ type: 'GroupArchived' });

    const expense = await recordExpense(groupId, ana.token, [{ memberId: ana.id, amount: 10 }], 10);
    expect(expense.status).toBe(409);
    expect(expense.body).toMatchObject({ type: 'GroupArchived' });

    const balancesRead = await balances(groupId, ben.token);
    expect(balancesRead.status).toBe(200);
    const members = (await http.get(`/v1/groups/${groupId}/members`, { token: ben.token })).body as unknown[];
    expect(members).toHaveLength(2);
  });
});

const settleInCash = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/settlements/cash`, { body, token });

describe('Groups → Ledger', () => {
  it('makes a group in Groups, archives it by the id its creation answered, and Ledger refuses an expense in it by that id', async () => {
    const ana = await accountOf('ana.archive.ledger@example.com', 'Ana');
    const created = await http.request('POST', '/v1/groups', {
      body: { name: 'Quiet', currency: 'EUR' },
      token: ana.token,
    });
    const groupId = (created.body as { id: string }).id;

    expect((await archive(groupId, ana.token)).body).toEqual({ id: groupId });

    const refused = await recordExpense(groupId, ana.token, [{ memberId: ana.id, amount: 10 }], 10);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ type: 'GroupArchived' });
    const expenses = await http.get(`/v1/groups/${groupId}/expenses`, { token: ana.token });
    expect(expenses.status).toBe(200);
    expect(expenses.body).toEqual([]);
  });
});

describe('Groups → Settlements', () => {
  it('archives a group in Groups by its id, and Settlements refuses a payment in it by that id, which records nothing', async () => {
    const ana = await accountOf('ana.archive.settlements@example.com', 'Ana');
    const ben = await accountOf('ben.archive.settlements@example.com', 'Ben');
    const groupId = await groupWith(ana, ben, 'Gym');

    expect((await archive(groupId, ana.token)).status).toBe(201);

    const refused = await settleInCash(groupId, ana.token, { from: ben.id, amount: 10 });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ type: 'GroupArchived' });
    const settlements = await http.get(`/v1/groups/${groupId}/settlements`, { token: ana.token });
    expect(settlements.body).toEqual([]);
  });
});

describe('Ledger → Groups', () => {
  it('records an expense in Ledger, and Groups refuses to archive while the balance it counts is not 0, by the expense’s own id', async () => {
    const ana = await accountOf('ana.archive.balance@example.com', 'Ana');
    const ben = await accountOf('ben.archive.balance@example.com', 'Ben');
    const groupId = await groupWith(ana, ben, 'Shared rent');
    const recorded = await recordExpense(
      groupId,
      ana.token,
      [
        { memberId: ana.id, amount: 50 },
        { memberId: ben.id, amount: 50 },
      ],
      100,
    );
    const expenseId = (recorded.body as { id: string }).id;

    const refused = await archive(groupId, ana.token);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ type: 'GroupNotSettled' });
    const expense = await http.get(`/v1/expenses/${expenseId}`, { token: ana.token });
    expect(expense.body).toMatchObject({ id: expenseId, groupId });
    expect((await getGroup(groupId, ana.token)).body).not.toHaveProperty('archivedAt');
  });
});

describe('Settlements → Groups', () => {
  it('pays a balance in cash in Settlements, and Groups archives the group once it is 0, the settlement still read by its own id', async () => {
    const ana = await accountOf('ana.archive.cash@example.com', 'Ana');
    const ben = await accountOf('ben.archive.cash@example.com', 'Ben');
    const groupId = await groupWith(ana, ben, 'Ski week');
    await recordExpense(
      groupId,
      ana.token,
      [
        { memberId: ana.id, amount: 50 },
        { memberId: ben.id, amount: 50 },
      ],
      100,
    );
    const paid = await settleInCash(groupId, ana.token, { from: ben.id, amount: 50 });
    expect(paid.status).toBe(201);
    const settlementId = (paid.body as { id: string }).id;

    const archived = await archive(groupId, ana.token);
    expect(archived.status).toBe(201);
    expect(archived.body).toEqual({ id: groupId });
    const settlement = await http.get(`/v1/settlements/${settlementId}`, { token: ana.token });
    expect(settlement.body).toMatchObject({ id: settlementId, groupId, status: 'paid' });
  });
});
