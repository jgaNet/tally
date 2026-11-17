import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Leaving a group, end to end (request 9): the application booted in this process on a free port, spoken to over HTTP,
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
  await joinGroup(groupId, owner, member);
  return groupId;
}

async function joinGroup(groupId: string, owner: { token: string }, member: { token: string }): Promise<void> {
  const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: member.token });
}

const leave = (groupId: string, token?: string) => http.request('POST', `/v1/groups/${groupId}/leave`, { token });
const getGroup = (groupId: string, token?: string) => http.get(`/v1/groups/${groupId}`, { token });
const members = (groupId: string, token?: string) => http.get(`/v1/groups/${groupId}/members`, { token });
const balances = (groupId: string, token?: string) => http.get(`/v1/groups/${groupId}/balances`, { token });
const myGroups = (token?: string) => http.get('/v1/groups/mine', { token });
const statement = (groupId: string, memberId: string, token?: string) =>
  http.get(`/v1/groups/${groupId}/members/${memberId}/statement`, { token });

/** An expense paid by `payer`, split exactly as given. */
const recordExpense = (groupId: string, payer: string, split: { memberId: string; amount: number }[], amount: number) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, {
    token: payer,
    body: { description: 'Dinner', amount, date: '2026-01-10', splitExactly: split },
  });

describe('leaving a group', () => {
  it('lets a member with a balance of 0 leave, and then the group is gone for them and they are no longer a member', async () => {
    const ana = await accountOf('ana.leave@example.com', 'Ana');
    const ben = await accountOf('ben.leave@example.com', 'Ben');
    const groupId = await groupWith(ana, ben, 'Lisbon');
    const own = await recordExpense(groupId, ben.token, [{ memberId: ben.id, amount: 100 }], 100);
    expect(own.status).toBe(201);

    const answer = await leave(groupId, ben.token);

    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: groupId });
    expect((await getGroup(groupId, ben.token)).status).toBe(404);
    expect(((await myGroups(ben.token)).body as { id: string }[]).some(group => group.id === groupId)).toBe(false);
    const listed = (await members(groupId, ana.token)).body as { memberId: string }[];
    expect(listed.map(member => member.memberId)).toEqual([ana.id]);
    const counted = (await balances(groupId, ana.token)).body as { memberId: string; balance: number }[];
    expect(counted.map(member => member.memberId)).toEqual([ana.id]);
  });

  it('refuses the owner, who cannot leave the group they created, as a refusal the caller reads at once', async () => {
    const ana = await accountOf('ana.owner.leave@example.com', 'Ana');
    const groupId = (
      (await http.request('POST', '/v1/groups', { body: { name: 'Owner', currency: 'EUR' }, token: ana.token }))
        .body as {
        id: string;
      }
    ).id;

    const answer = await leave(groupId, ana.token);

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ type: 'OwnerCannotLeave', message: expect.any(String) });
    expect((await getGroup(groupId, ana.token)).status).toBe(200);
  });

  it('refuses a member whose balance is not 0, as BalanceNotZero, and keeps them in the group', async () => {
    const ana = await accountOf('ana.balance.leave@example.com', 'Ana');
    const ben = await accountOf('ben.balance.leave@example.com', 'Ben');
    const groupId = await groupWith(ana, ben, 'Porto');
    await recordExpense(
      groupId,
      ana.token,
      [
        { memberId: ana.id, amount: 50 },
        { memberId: ben.id, amount: 50 },
      ],
      100,
    );

    const answer = await leave(groupId, ben.token);

    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ type: 'BalanceNotZero', message: expect.any(String) });
    expect((await getGroup(groupId, ben.token)).status).toBe(200);
  });

  it('keeps a former member’s expenses and statement readable, and refuses to change or put them in a split', async () => {
    const ana = await accountOf('ana.former@example.com', 'Ana');
    const ben = await accountOf('ben.former@example.com', 'Ben');
    const cara = await accountOf('cara.former@example.com', 'Cara');
    const groupId = await groupWith(ana, ben, 'Oslo');
    await joinGroup(groupId, ana, cara);
    const dinner = (
      (await recordExpense(groupId, ben.token, [{ memberId: ben.id, amount: 100 }], 100)).body as { id: string }
    ).id;
    expect((await leave(groupId, ben.token)).status).toBe(201);

    const readStatement = await statement(groupId, ben.id, ana.token);
    expect(readStatement.status).toBe(200);
    expect(readStatement.body).toMatchObject({ memberId: ben.id, balance: 0 });
    expect((readStatement.body as { entries: unknown[] }).entries.length).toBe(1);

    const deleted = await http.request('DELETE', `/v1/expenses/${dinner}`, { token: ana.token });
    expect(deleted.status).toBe(409);
    expect(deleted.body).toEqual({ type: 'ExpenseOfFormerMember', message: expect.any(String) });

    const newSplit = await recordExpense(groupId, ana.token, [{ memberId: ben.id, amount: 100 }], 100);
    expect(newSplit.status).toBe(400);
    expect(newSplit.body).toEqual({ type: 'SplitWithStranger', message: expect.any(String) });
  });

  it('lets a former member join again, last among the members, with the balance their earlier expenses give them', async () => {
    const ana = await accountOf('ana.rejoin@example.com', 'Ana');
    const ben = await accountOf('ben.rejoin@example.com', 'Ben');
    const cara = await accountOf('cara.rejoin@example.com', 'Cara');
    const groupId = await groupWith(ana, ben, 'Riga');
    await joinGroup(groupId, ana, cara);
    await leave(groupId, ben.token);

    await joinGroup(groupId, ana, ben);

    const listed = (await members(groupId, ana.token)).body as { memberId: string }[];
    expect(listed.map(member => member.memberId)).toEqual([ana.id, cara.id, ben.id]);
    expect((await getGroup(groupId, ben.token)).status).toBe(200);
    const counted = (await balances(groupId, ana.token)).body as { memberId: string; balance: number }[];
    expect(counted.find(member => member.memberId === ben.id)).toEqual({ memberId: ben.id, balance: 0 });
  });
});

describe('Groups → Ledger', () => {
  it('finds a group made in Groups by the id its creation answered, and Ledger takes an expense in it, read back by that id', async () => {
    const ana = await accountOf('ana.groups.ledger@example.com', 'Ana');
    const ben = await accountOf('ben.groups.ledger@example.com', 'Ben');
    const created = await http.request('POST', '/v1/groups', {
      body: { name: 'Bridge', currency: 'EUR' },
      token: ana.token,
    });
    const groupId = (created.body as { id: string }).id;
    await joinGroup(groupId, ana, ben);

    const recorded = await recordExpense(
      groupId,
      ana.token,
      [
        { memberId: ana.id, amount: 0 },
        { memberId: ben.id, amount: 100 },
      ],
      100,
    );

    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;
    const listed = (await http.get(`/v1/groups/${groupId}/expenses`, { token: ben.token })).body as {
      id: string;
      groupId: string;
    }[];
    expect(listed.find(expense => expense.id === expenseId)?.groupId).toBe(groupId);
  });
});

describe('Ledger → Groups', () => {
  it('asks Ledger a member’s balance when it leaves: refused while it is not 0, and once even, left by the id its group answered', async () => {
    const ana = await accountOf('ana.ledger.groups@example.com', 'Ana');
    const ben = await accountOf('ben.ledger.groups@example.com', 'Ben');
    const groupId = await groupWith(ana, ben, 'Quay');
    await recordExpense(
      groupId,
      ana.token,
      [
        { memberId: ana.id, amount: 50 },
        { memberId: ben.id, amount: 50 },
      ],
      100,
    );
    const refused = await leave(groupId, ben.token);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ type: 'BalanceNotZero', message: expect.any(String) });

    await recordExpense(
      groupId,
      ben.token,
      [
        { memberId: ben.id, amount: 0 },
        { memberId: ana.id, amount: 50 },
      ],
      50,
    );
    const answer = await leave(groupId, ben.token);

    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: groupId });
  });
});
