import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The group's expenses and a member's statement, end to end: the application booted in this process on a free port,
 * spoken to over HTTP, every answer held to api/8-history-and-statement.yaml by the client. One application per suite,
 * shared by its tests in order.
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

/** A group founded by `owner`, which each of `others` joins by an invitation: the group's id. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The trip', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  for (const other of others) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
    const invitationId = (invitation.body as { id: string }).id;
    const joined = await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: other.token });
    expect(joined.status).toBe(201);
  }
  return groupId;
}

const record = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, { body, token });
const editExpense = (id: string, token: string, body: unknown) =>
  http.request('PUT', `/v1/expenses/${id}`, { body, token });
const deleteExpense = (id: string, token: string) => http.request('DELETE', `/v1/expenses/${id}`, { token });
const listExpenses = (groupId: string, token?: string) => http.get(`/v1/groups/${groupId}/expenses`, { token });
const statementOf = (groupId: string, memberId: string, token?: string) =>
  http.get(`/v1/groups/${groupId}/members/${memberId}/statement`, { token });
const balancesOf = (groupId: string, token: string) => http.get(`/v1/groups/${groupId}/balances`, { token });

describe('a group’s expenses, and a member’s statement', () => {
  it('lists the group’s expenses the latest date first, then the most recently recorded, and leaves out the deleted', async () => {
    const ana = await accountOf('ana.history@example.com', 'Ana');
    const ben = await accountOf('ben.history@example.com', 'Ben');
    const cal = await accountOf('cal.history@example.com', 'Cal');
    const groupId = await groupWith(ana, [ben, cal]);

    // Recorded first: 5 January, split equally three ways, paid by Ana.
    const first = (await record(groupId, ana.token, {
      description: 'Hotel',
      amount: 900,
      date: '2020-01-05',
      splitBetween: [ana.id, ben.id, cal.id],
    })) as { body: { id: string } };
    // Recorded second: 2 January, paid by Ben between him and Cal.
    const second = (await record(groupId, ben.token, {
      description: 'Train',
      amount: 600,
      date: '2020-01-02',
      splitBetween: [ben.id, cal.id],
    })) as { body: { id: string } };
    // Recorded third: 5 January as well, so it comes before the first, which was recorded earlier that day.
    const third = (await record(groupId, ana.token, {
      description: 'Dinner',
      amount: 500,
      date: '2020-01-05',
      splitExactly: [
        { memberId: ana.id, amount: 100 },
        { memberId: ben.id, amount: 400 },
      ],
    })) as { body: { id: string } };
    // Recorded fourth, on 3 January, and deleted by its payer before anyone reads the statements.
    const fourth = (await record(groupId, cal.token, {
      description: 'Tea',
      amount: 90,
      date: '2020-01-03',
      splitBetween: [cal.id, ana.id],
    })) as { body: { id: string } };
    expect(fourth.body.id).toBeTruthy();

    const before = await listExpenses(groupId, ana.token);
    expect(before.status).toBe(200);
    const beforeIds = (before.body as { id: string }[]).map(expense => expense.id);
    expect(beforeIds).toEqual([third.body.id, first.body.id, fourth.body.id, second.body.id]);

    expect((await deleteExpense(fourth.body.id, cal.token)).status).toBe(201);

    // An edit of the first expense does not make it the most recently recorded: the third one is still before it.
    const current = (await http.get(`/v1/expenses/${first.body.id}`, { token: ana.token })).body as { version: number };
    const edited = await editExpense(first.body.id, ana.token, {
      description: 'Hotel, two nights',
      amount: 900,
      date: '2020-01-05',
      splitBetween: [ana.id, ben.id, cal.id],
      version: current.version,
    });
    expect(edited.status).toBe(201);

    const after = await listExpenses(groupId, cal.token);
    expect(after.status).toBe(200);
    const listed = after.body as { id: string; description: string; version: number }[];
    expect(listed.map(expense => expense.id)).toEqual([third.body.id, first.body.id, second.body.id]);
    expect(listed[1]).toMatchObject({ description: 'Hotel, two nights', version: 2 });
  });

  it('reads a member’s statement, the earliest date first, with the balance after each entry, and the balance the group gives', async () => {
    const ana = await accountOf('ana.statement@example.com', 'Ana');
    const ben = await accountOf('ben.statement@example.com', 'Ben');
    const cal = await accountOf('cal.statement@example.com', 'Cal');
    const groupId = await groupWith(ana, [ben, cal]);

    const hotel = (await record(groupId, ana.token, {
      description: 'Hotel',
      amount: 900,
      date: '2020-01-05',
      splitBetween: [ana.id, ben.id, cal.id],
    })) as { body: { id: string } };
    const train = (await record(groupId, ben.token, {
      description: 'Train',
      amount: 600,
      date: '2020-01-02',
      splitBetween: [ben.id, cal.id],
    })) as { body: { id: string } };
    const dinner = (await record(groupId, ana.token, {
      description: 'Dinner',
      amount: 500,
      date: '2020-01-05',
      splitExactly: [
        { memberId: ana.id, amount: 100 },
        { memberId: ben.id, amount: 400 },
      ],
    })) as { body: { id: string } };

    const bens = await statementOf(groupId, ben.id, cal.token);
    expect(bens.status).toBe(200);
    expect(bens.body).toEqual({
      memberId: ben.id,
      balance: -400,
      entries: [
        { expenseId: train.body.id, date: '2020-01-02', description: 'Train', paid: 600, share: 300, balance: 300 },
        { expenseId: hotel.body.id, date: '2020-01-05', description: 'Hotel', paid: 0, share: 300, balance: 0 },
        { expenseId: dinner.body.id, date: '2020-01-05', description: 'Dinner', paid: 0, share: 400, balance: -400 },
      ],
    });

    const anas = (await statementOf(groupId, ana.id, ben.token)).body as { balance: number; entries: unknown[] };
    expect(anas.entries).toEqual([
      { expenseId: hotel.body.id, date: '2020-01-05', description: 'Hotel', paid: 900, share: 300, balance: 600 },
      { expenseId: dinner.body.id, date: '2020-01-05', description: 'Dinner', paid: 500, share: 100, balance: 1000 },
    ]);
    expect(anas.balance).toBe(1000);

    const cals = (await statementOf(groupId, cal.id, ana.token)).body as { balance: number };
    expect(cals.balance).toBe(-600);

    // Each statement's balance is the one the group's balances give its member.
    const balances = (await balancesOf(groupId, ana.token)).body as { memberId: string; balance: number }[];
    const balanceOf = (memberId: string) => balances.find(balance => balance.memberId === memberId)?.balance;
    expect(balanceOf(ben.id)).toBe(-400);
    expect(balanceOf(ana.id)).toBe(1000);
    expect(balanceOf(cal.id)).toBe(-600);
  });

  it('gives a member with no expense an empty statement at balance 0', async () => {
    const ana = await accountOf('ana.empty@example.com', 'Ana');
    const ben = await accountOf('ben.empty@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);

    const statement = await statementOf(groupId, ben.id, ana.token);
    expect(statement.status).toBe(200);
    expect(statement.body).toEqual({ memberId: ben.id, balance: 0, entries: [] });
    expect(await listExpenses(groupId, ana.token)).toMatchObject({ status: 200, body: [] });
  });

  it('answers a group that is not there, or whose expenses and statements a caller may not read, as not found', async () => {
    const ana = await accountOf('ana.outsider@example.com', 'Ana');
    const ben = await accountOf('ben.outsider@example.com', 'Ben');
    const dee = await accountOf('dee.outsider@example.com', 'Dee');
    const groupId = await groupWith(ana, [ben]);

    expect((await listExpenses(groupId, dee.token)).status).toBe(404);
    expect((await statementOf(groupId, ben.id, dee.token)).status).toBe(404);
    expect((await listExpenses('no-such-group', ana.token)).status).toBe(404);
    expect((await statementOf('no-such-group', ben.id, ana.token)).status).toBe(404);
  });

  it('does not show a statement of someone who has never been a member of the group', async () => {
    const ana = await accountOf('ana.stranger@example.com', 'Ana');
    const ben = await accountOf('ben.stranger@example.com', 'Ben');
    const dee = await accountOf('dee.stranger@example.com', 'Dee');
    const groupId = await groupWith(ana, [ben]);

    const statement = await statementOf(groupId, dee.id, ben.token);
    expect(statement.status).toBe(404);
  });

  it('refuses a caller who is not signed in, at the transport, before anything is read', async () => {
    const ana = await accountOf('ana.anonymous@example.com', 'Ana');
    const groupId = await groupWith(ana, []);

    expect((await listExpenses(groupId)).status).toBe(401);
    expect((await statementOf(groupId, ana.id)).status).toBe(401);
  });
});

describe('Groups → Ledger', () => {
  it('finds a group made through Groups by the id its creation answered, in Ledger’s expenses and statements', async () => {
    const ana = await accountOf('ana.handoff@example.com', 'Ana');

    const created = await http.request('POST', '/v1/groups', {
      body: { name: 'The allotment', currency: 'GBP' },
      token: ana.token,
    });
    expect(created.status).toBe(201);
    const groupId = (created.body as { id: string }).id;

    const expenses = await listExpenses(groupId, ana.token);
    expect(expenses).toMatchObject({ status: 200, body: [] });

    const statement = await statementOf(groupId, ana.id, ana.token);
    expect(statement).toMatchObject({
      status: 200,
      body: { memberId: ana.id, balance: 0, entries: [] },
    });
  });
});
