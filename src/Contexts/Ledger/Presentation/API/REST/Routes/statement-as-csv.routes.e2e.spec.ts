import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * A member's statement with the settlements the balances count (request 29), as JSON and as CSV, end to end: every answer held to
 * api/ by the client. One application per suite, shared by its tests in order.
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

async function groupWith(owner: { token: string }, other: { token: string }): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
  const joined = await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: other.token,
  });
  expect(joined.status).toBe(201);
  return groupId;
}

const statementOf = (groupId: string, memberId: string, token?: string) =>
  http.get(`/v1/groups/${groupId}/members/${memberId}/statement`, { token });
/** The day the balances counted a settlement, which a cash settlement is counted from its recording (request 29). */
const countedDayOf = async (settlementId: string, token: string): Promise<string> =>
  ((await http.get(`/v1/settlements/${settlementId}`, { token })).body as { at: string }).at.slice(0, 10);
const statementCsvOf = (groupId: string, memberId: string, token?: string) =>
  http.get(`/v1/groups/${groupId}/members/${memberId}/statement.csv`, { token });

describe('a member’s statement with settlements, and as CSV', () => {
  it('lists the expenses and the cash settlements the balances count, in order, each with its kind and its balance', async () => {
    const ana = await accountOf('ana.csv@example.com', 'Ana');
    const ben = await accountOf('ben.csv@example.com', 'Ben');
    const groupId = await groupWith(ana, ben);

    const dinner = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner, "the good one"', amount: 1000, date: '2020-01-05', splitBetween: [ana.id, ben.id] },
      token: ana.token,
    });
    const expenseId = (dinner.body as { id: string }).id;
    const paid = await http.request('POST', `/v1/groups/${groupId}/settlements/cash`, {
      body: { from: ben.id, amount: 300 },
      token: ana.token,
    });
    expect(paid.status).toBe(201);
    const settlementId = (paid.body as { id: string }).id;
    const countedOn = await countedDayOf(settlementId, ana.token);

    const statement = await statementOf(groupId, ana.id, ana.token);
    expect(statement.status).toBe(200);
    expect(statement.body).toEqual({
      memberId: ana.id,
      balance: 200,
      entries: [
        {
          kind: 'expense',
          expenseId,
          date: '2020-01-05',
          description: 'Dinner, "the good one"',
          paid: 1000,
          share: 500,
          balance: 500,
        },
        {
          kind: 'settlement',
          settlementId,
          date: countedOn,
          description: 'Settlement in cash',
          paid: 0,
          share: 300,
          balance: 200,
        },
      ],
    });
  });

  it('answers the same statement as CSV, with its header, CRLF lines, and quotes only where a field needs them', async () => {
    const ana = await accountOf('ana.csv2@example.com', 'Ana');
    const ben = await accountOf('ben.csv2@example.com', 'Ben');
    const groupId = await groupWith(ana, ben);

    const dinner = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Dinner, "the good one"', amount: 1000, date: '2020-01-05', splitBetween: [ana.id, ben.id] },
      token: ana.token,
    });
    const expenseId = (dinner.body as { id: string }).id;
    const paid = await http.request('POST', `/v1/groups/${groupId}/settlements/cash`, {
      body: { from: ben.id, amount: 300 },
      token: ana.token,
    });
    const settlementId = (paid.body as { id: string }).id;
    const countedOn = await countedDayOf(settlementId, ana.token);

    const csv = await statementCsvOf(groupId, ben.id, ben.token);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(csv.body).toBe(
      [
        'date,kind,id,description,paid,share,balance',
        `2020-01-05,expense,${expenseId},"Dinner, ""the good one""",0,500,-500`,
        `${countedOn},settlement,${settlementId},Settlement in cash,300,0,-200`,
        '',
      ].join('\r\n'),
    );
  });

  it('refuses a statement as CSV to someone who is not signed in', async () => {
    const ana = await accountOf('ana.csv3@example.com', 'Ana');
    const ben = await accountOf('ben.csv3@example.com', 'Ben');
    const groupId = await groupWith(ana, ben);

    const anonymous = await statementCsvOf(groupId, ana.id);
    expect(anonymous.status).toBe(401);
  });
});
