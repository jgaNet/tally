import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * The relationship request 37 crosses, proved through the API: a group is made in Groups and its id is kept, then Ledger is read through the
 * API and finds the group by that same id (Groups → Ledger, through GroupMembers and GroupCurrency).
 */

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

type Operation = { status: string; result?: string; error?: { type: string; message: string } };

async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password: 'correct horse', name } });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'correct horse' } });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

describe('the relationships request 37 crosses', () => {
  it('Groups → Ledger (GroupMembers, GroupCurrency): a group made in Groups is the group an expense is recorded in, its currency and its members are read under its id, and what a person spent in it is found by that id', async () => {
    const ann = await signedIn('insight-rel-ann@example.com', 'Ann');
    const ben = await signedIn('insight-rel-ben@example.com', 'Ben');

    // Made in Groups: the id its own request answered.
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Trip', currency: 'CHF' },
    });
    const groupId = (await outcome((created.body as { operationId: string }).operationId, ann.token)).result as string;

    const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    const invitation = (await outcome((invite.body as { operationId: string }).operationId, ann.token))
      .result as string;
    const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: ben.token });
    await outcome((accepted.body as { operationId: string }).operationId, ben.token);

    // Ledger takes the group by that id: its members split the expense, and its currency is the one it is counted in.
    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: {
        description: 'Train',
        amount: 50000,
        date: '2026-04-12',
        category: 'travel',
        splitBetween: [ann.id, ben.id],
      },
    });
    const expenseId = (await outcome((recorded.body as { operationId: string }).operationId, ann.token))
      .result as string;
    expect(expenseId).toBeDefined();

    // Read through Ledger's API, found by the group's id.
    const expenses = await http.get(`${api}/groups/${groupId}/expenses`, { token: ann.token });
    expect(expenses.status).toBe(200);
    expect(expenses.body).toEqual([expect.objectContaining({ id: expenseId, groupId })]);

    const insights = await http.get(`${api}/accounts/me/insights`, { token: ann.token });
    expect(insights.body).toEqual([{ month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 }]);
  });
});
