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

async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

async function join(token: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: joiner });
  await outcome((accepted.body as { operationId: string }).operationId, joiner);
}

describe('Ledger → Notifications', () => {
  it('finds, by the id the expense request answered, the notice the expense made for a member', async () => {
    const payer = await signedIn('relation-payer@example.com', 'Rue');
    const member = await signedIn('relation-member@example.com', 'Ivo');
    const group = await createGroup(payer.token, 'Relation');
    await join(payer.token, group, member.token);

    const answer = await http.request('POST', `${api}/groups/${group}/expenses`, {
      token: payer.token,
      body: { description: 'Tickets', amount: 600, date: '2026-03-11', splitBetween: [payer.id, member.id] },
    });
    const expenseId = (await outcome((answer.body as { operationId: string }).operationId, payer.token))
      .result as string;

    let found: { expenseId: string; groupId: string; amount: number } | undefined;
    for (let attempt = 0; attempt < 250 && !found; attempt++) {
      const { body } = await http.get(`${api}/notices`, { token: member.token });
      found = (body as { expenseId: string; groupId: string; amount: number }[]).find(
        notice => notice.expenseId === expenseId,
      );
      if (!found) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(found).toEqual({
      id: expect.any(String),
      kind: 'expense',
      groupId: group,
      expenseId,
      amount: 300,
      at: expect.any(String),
    });

    // The payer recorded the expense and has no notice for it.
    const payerNotices = await http.get(`${api}/notices`, { token: payer.token });
    expect((payerNotices.body as { expenseId: string }[]).some(notice => notice.expenseId === expenseId)).toBe(false);
  });
});
