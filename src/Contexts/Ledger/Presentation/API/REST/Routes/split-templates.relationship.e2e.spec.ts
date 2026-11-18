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
  const email = `${name.toLowerCase()}-relationship-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

describe('Groups → Ledger (GroupMembers): a group Groups makes is the one its split templates and expenses are kept in, by the id it answered', () => {
  it('reads the templates and the expense Ledger keeps for the group, by the group id Groups answered', async () => {
    const ann = await person('Ann');

    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ann.token,
    });
    const groupId = (
      (await outcome((created.body as Body).operationId as string, ann.token)).body as { result: { id: string } }
    ).result.id;

    const saved = await http.request('POST', `${api}/groups/${groupId}/templates`, {
      body: { name: 'Just Ann', splitBetween: [ann.id] },
      token: ann.token,
    });
    const savedOutcome = await outcome((saved.body as Body).operationId as string, ann.token);
    expect(savedOutcome.body.status).toBe('SUCCESS');
    const templateId = (savedOutcome.body.result as { id: string }).id;

    const listed = await http.get(`${api}/groups/${groupId}/templates`, { token: ann.token });
    expect(listed.body).toEqual([{ id: templateId, groupId, name: 'Just Ann', splitBetween: [ann.id] }]);

    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Shopping', amount: 500, date: '2026-11-01', template: templateId },
      token: ann.token,
    });
    const expenseOutcome = await outcome((recorded.body as Body).operationId as string, ann.token);
    expect(expenseOutcome.body.status).toBe('SUCCESS');
    const expenseId = (expenseOutcome.body.result as { id: string }).id;

    const read = await http.get(`${api}/expenses/${expenseId}`, { token: ann.token });
    expect(read.body).toMatchObject({ groupId, paidBy: ann.id, splitKind: 'equal', amount: 500 });
  });
});
