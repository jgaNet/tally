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

type Body = Record<string, unknown>;

async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

async function person(name: string) {
  const email = `${name.toLowerCase()}-insights-relationship-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

describe('Groups → Ledger (GroupMembers, GroupCurrency): a group Groups makes is the one Ledger reads in a person’s insights, by the id it answered', () => {
  it('reads the expense Ledger keeps for the group Groups made, and the insights in the currency Groups made it in', async () => {
    const ann = await person('Ann');

    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Trip', currency: 'CHF' },
      token: ann.token,
    });
    const groupId = (
      (await outcome((created.body as Body).operationId as string, ann.token)).body as { result: { id: string } }
    ).result.id;

    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Train', amount: 25000, date: '2026-04-20', category: 'travel', splitBetween: [ann.id] },
      token: ann.token,
    });
    const expenseOutcome = await outcome((recorded.body as Body).operationId as string, ann.token);
    expect(expenseOutcome.body.status).toBe('SUCCESS');
    const expenseId = (expenseOutcome.body.result as { id: string }).id;

    const read = await http.get(`${api}/expenses/${expenseId}`, { token: ann.token });
    expect(read.body).toMatchObject({ groupId, paidBy: ann.id, amount: 25000, category: 'travel' });

    // Ledger finds the group through GroupMembers (the account's groups) and its currency through GroupCurrency.
    const insights = await http.get(`${api}/accounts/me/insights`, { token: ann.token });
    expect(insights.body).toEqual([{ month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 }]);
  });
});
