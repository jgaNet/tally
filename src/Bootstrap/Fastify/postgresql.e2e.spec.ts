import { Pool } from 'pg';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The application on PostgreSQL, end to end (ADR 20): the relationships between contexts still answer what they did, with
 * the state in one database. The application booted in this process on a free port, spoken to over HTTP, every answer held
 * to api/ by the client. One application per suite, shared by its tests in order.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
/** The database itself, to see where the state is kept: PostgreSQL, under the ids the API answered (ADR 20). */
let pool: Pool;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
});
afterAll(async () => {
  await app.stop();
  await pool.end();
});

/** How many rows of the table have this id: the thing made through the API is stored in the database. */
const rowsWithId = async (table: string, id: string): Promise<number> =>
  Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE id = $1`, [id])).rows[0].n);

const PASSWORD = 'correct horse';
const SPENT = '2026-02-01';

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group founded by `owner`, which `member` joined by an invitation. */
async function groupWith(owner: { token: string }, member: { token: string }, name: string): Promise<string> {
  const created = await http.request('POST', '/v1/groups', { body: { name, currency: 'EUR' }, token: owner.token });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
  await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: member.token,
  });
  return groupId;
}

describe('Groups → Ledger', () => {
  it('makes a group in Groups, records an expense in it by the id the creation answered, and Ledger reads it back by that id', async () => {
    const ana = await accountOf('ana.postgresql.ledger@example.com', 'Ana');
    const bea = await accountOf('bea.postgresql.ledger@example.com', 'Bea');
    const groupId = await groupWith(ana, bea, 'Stored');

    const expense = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 40, date: SPENT, splitBetween: [ana.id, bea.id] },
      token: ana.token,
    });
    expect(expense.status).toBe(201);
    const expenseId = (expense.body as { id: string }).id;
    expect(await rowsWithId('groups', groupId)).toBe(1);
    expect(await rowsWithId('expenses', expenseId)).toBe(1);

    const read = await http.get(`/v1/expenses/${expenseId}`, { token: ana.token });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: expenseId, groupId, amount: 40 });

    const balances = (await http.get(`/v1/groups/${groupId}/balances`, { token: ana.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances).toEqual([
      { memberId: ana.id, balance: 20 },
      { memberId: bea.id, balance: -20 },
    ]);
  });
});

describe('Settlements → Ledger', () => {
  it('records a cash settlement in Settlements by the id it answered, and Ledger shows that settlement in the statement by the same id', async () => {
    const ann = await accountOf('ann.postgresql.ledger@example.com', 'Ann');
    const bob = await accountOf('bob.postgresql.ledger@example.com', 'Bob');
    const groupId = await groupWith(ann, bob, 'Settled');
    const expense = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: SPENT, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    expect(expense.status).toBe(201);

    const settled = await http.request('POST', `/v1/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 30 },
      token: ann.token,
    });
    expect(settled.status).toBe(201);
    const settlementId = (settled.body as { id: string }).id;
    expect(await rowsWithId('settlements', settlementId)).toBe(1);

    const statement = await http.get(`/v1/groups/${groupId}/members/${bob.id}/statement`, { token: bob.token });
    expect(statement.status).toBe(200);
    const entries = (statement.body as { entries: { kind: string; settlementId?: string }[] }).entries.filter(
      entry => entry.kind === 'settlement',
    );
    expect(entries).toEqual([expect.objectContaining({ settlementId, kind: 'settlement' })]);
  });
});
