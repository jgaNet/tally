import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The audit of a group, end to end (request 28): every change of money is an entry, written with the change, read by a
 * member the oldest first; to anyone else the group does not exist. One application per suite, shared by its tests in order.
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

async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

async function groupWith(owner: { token: string }, member: { token: string }, name: string): Promise<string> {
  const created = await http.request('POST', '/v1/groups', { body: { name, currency: 'EUR' }, token: owner.token });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
  await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: member.token,
  });
  return groupId;
}

const audit = (groupId: string, token?: string) => http.get(`/v1/groups/${groupId}/audit`, { token });
const recordExpense = (groupId: string, token: string, amount: number, split: { memberId: string; amount: number }[]) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, {
    token,
    body: { description: 'Dinner', amount, date: '2026-01-10', splitExactly: split },
  });

const AUDIT_KEYS = ['action', 'amount', 'at', 'by', 'id', 'subjectId'];
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe('the audit of a group', () => {
  it('writes an entry for each change of money, with the change, and reads them oldest first to a member only', async () => {
    const ana = await accountOf('ana.audit@example.com', 'Ana');
    const ben = await accountOf('ben.audit@example.com', 'Ben');
    const zoe = await accountOf('zoe.audit@example.com', 'Zoe');
    const groupId = await groupWith(ana, ben, 'Dinners');

    const recorded = await recordExpense(groupId, ana.token, 100, [
      { memberId: ana.id, amount: 50 },
      { memberId: ben.id, amount: 50 },
    ]);
    const expenseId = (recorded.body as { id: string }).id;

    const current = (await http.get(`/v1/expenses/${expenseId}`, { token: ana.token })).body as { version: number };
    const edited = await http.request('PUT', `/v1/expenses/${expenseId}`, {
      token: ana.token,
      body: {
        version: current.version,
        description: 'Dinner',
        amount: 60,
        date: '2026-01-10',
        splitExactly: [
          { memberId: ana.id, amount: 30 },
          { memberId: ben.id, amount: 30 },
        ],
      },
    });
    expect(edited.status).toBe(201);

    const paid = await http.request('POST', `/v1/groups/${groupId}/settlements/cash`, {
      token: ana.token,
      body: { from: ben.id, amount: 30 },
    });
    const settlementId = (paid.body as { id: string }).id;

    const deleted = await http.request('DELETE', `/v1/expenses/${expenseId}`, { token: ana.token });
    expect(deleted.status).toBe(201);

    const read = await audit(groupId, ben.token);
    expect(read.status).toBe(200);
    const entries = read.body as Record<string, unknown>[];
    expect(entries.map(entry => entry.action)).toEqual([
      'expense-recorded',
      'expense-edited',
      'settlement-paid',
      'expense-deleted',
    ]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(AUDIT_KEYS);
      expect(entry.at).toMatch(AT);
    }
    expect(entries.map(entry => entry.at)).toEqual([...entries.map(entry => entry.at)].sort());
    expect(entries[0]).toMatchObject({ by: ana.id, subjectId: expenseId, amount: 100 });
    expect(entries[1]).toMatchObject({ by: ana.id, subjectId: expenseId, amount: 60 });
    expect(entries[2]).toMatchObject({ by: ana.id, subjectId: settlementId, amount: 30 });
    expect(entries[3]).toMatchObject({ by: ana.id, subjectId: expenseId, amount: 60 });

    expect((await audit(groupId, zoe.token)).status).toBe(404);
    expect((await audit(groupId)).status).toBe(401);
  });

  it('keeps the balance a member passed on when they left, as an entry by the member who left', async () => {
    const ana = await accountOf('ana.audit.leave@example.com', 'Ana');
    const ben = await accountOf('ben.audit.leave@example.com', 'Ben');
    const groupId = await groupWith(ana, ben, 'Trip');
    await recordExpense(groupId, ben.token, 100, [
      { memberId: ana.id, amount: 50 },
      { memberId: ben.id, amount: 50 },
    ]);

    const left = await http.request('POST', `/v1/groups/${groupId}/leave`, { token: ben.token });
    expect(left.status).toBe(201);

    const entries = (await audit(groupId, ana.token)).body as {
      action: string;
      by: string;
      subjectId: string;
      amount: number;
    }[];
    expect(entries.map(entry => entry.action)).toEqual(['expense-recorded', 'balance-passed']);
    expect(entries[1]).toMatchObject({ by: ben.id, subjectId: ben.id, amount: 50 });
  });
});

describe('Groups → Ledger', () => {
  it('makes a group in Groups, passes a member’s balance on when they leave it, and Ledger finds the passing by the group’s id', async () => {
    const ana = await accountOf('ana.audit.groups@example.com', 'Ana');
    const ben = await accountOf('ben.audit.groups@example.com', 'Ben');
    const created = await http.request('POST', '/v1/groups', {
      body: { name: 'Lisbon', currency: 'EUR' },
      token: ana.token,
    });
    const groupId = (created.body as { id: string }).id;
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: ana.token });
    await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: ben.token,
    });
    await recordExpense(groupId, ben.token, 100, [
      { memberId: ana.id, amount: 50 },
      { memberId: ben.id, amount: 50 },
    ]);

    const left = await http.request('POST', `/v1/groups/${groupId}/leave`, { token: ben.token });
    expect(left.status).toBe(201);

    const entries = (await audit(groupId, ana.token)).body as {
      action: string;
      by: string;
      subjectId: string;
      amount: number;
    }[];
    const passed = entries.find(entry => entry.action === 'balance-passed');
    expect(passed).toMatchObject({ by: ben.id, subjectId: ben.id, amount: 50 });
    expect((await audit(groupId, ben.token)).status).toBe(404);
  });
});

describe('Settlements → Ledger', () => {
  it('records a cash settlement in Settlements, and Ledger finds its entry by the settlement’s own id', async () => {
    const ana = await accountOf('ana.audit.settlements@example.com', 'Ana');
    const ben = await accountOf('ben.audit.settlements@example.com', 'Ben');
    const groupId = await groupWith(ana, ben, 'Ski week');
    await recordExpense(groupId, ana.token, 100, [
      { memberId: ana.id, amount: 50 },
      { memberId: ben.id, amount: 50 },
    ]);

    const paid = await http.request('POST', `/v1/groups/${groupId}/settlements/cash`, {
      token: ana.token,
      body: { from: ben.id, amount: 50 },
    });
    expect(paid.status).toBe(201);
    const settlementId = (paid.body as { id: string }).id;

    const entries = (await audit(groupId, ben.token)).body as {
      id: string;
      action: string;
      by: string;
      amount: number;
      subjectId: string;
    }[];
    expect(entries.find(entry => entry.subjectId === settlementId)).toMatchObject({
      action: 'settlement-paid',
      by: ana.id,
      amount: 50,
    });
  });
});
