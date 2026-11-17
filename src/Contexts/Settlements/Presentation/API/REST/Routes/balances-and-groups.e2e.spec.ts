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
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
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

/** Records an expense paid by the caller and returns the expense's id, as the operation's result gives it. */
async function record(token: string, groupId: string, amount: number, members: string[]): Promise<string> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token,
    body: { description: 'Dinner', amount, date: '2026-03-10', splitBetween: members },
  });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

describe('Groups → Settlements (SettlementMembers): a group made in Groups is found by Settlements under its id', () => {
  it('answers the suggested settlements of the group its id names, to its members, and no one else', async () => {
    const ann = await signedIn('membership-ann@example.com', 'Ann');
    const stranger = await signedIn('membership-sam@example.com', 'Sam');
    const group = await createGroup(ann.token, 'Club');

    const answer = await http.get(`${api}/groups/${group}/settlements/suggested`, { token: ann.token });
    expect(answer).toMatchObject({ status: 200, body: [] });

    const refused = await http.get(`${api}/groups/${group}/settlements/suggested`, { token: stranger.token });
    expect(refused.status).not.toBe(200);
  });
});

describe('Ledger → Settlements (GroupBalances): an expense recorded in Ledger is read by Settlements under its group', () => {
  it('moves the suggested settlement by the share the expense recorded, in the group the expense was made in', async () => {
    const ann = await signedIn('ledger-ann@example.com', 'Ann');
    const ben = await signedIn('ledger-ben@example.com', 'Ben');
    const group = await createGroup(ann.token, 'Flat');
    await join(ann.token, group, ben.token);

    const expense = await record(ann.token, group, 900, [ann.id, ben.id]);
    expect(expense).toEqual(expect.any(String));

    const suggested = await http.get(`${api}/groups/${group}/settlements/suggested`, { token: ben.token });
    expect(suggested).toMatchObject({ status: 200, body: [{ from: ben.id, to: ann.id, amount: 450 }] });
  });
});
