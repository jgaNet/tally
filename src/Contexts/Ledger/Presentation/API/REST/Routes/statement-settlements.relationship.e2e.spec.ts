import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  // The day the server keeps, read from a signup it answers, as the statement's own spec does.
  const probe = await http.request('POST', `${api}/accounts`, {
    body: { email: 'statement-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const done = await outcome((probe.body as Body).operationId as string);
  serverToday = String((done.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(() => app.stop());

type Body = Record<string, unknown>;

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-statement-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Runs a request that answers an operation, and answers the id its result carries. */
async function resultIdOf(answer: { body: unknown }, token: string) {
  const done = await outcome((answer.body as Body).operationId as string, token);
  return (done.body as { result: { id: string } }).result.id;
}

describe("Settlements → Ledger (SettledAmounts): a settlement Settlements makes is one Ledger's statement lists, by the id it answered", () => {
  it('lists the settlement in the statement of the member who paid it, by the id its request answered, and in the CSV', async () => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: alice.token,
    });
    const groupId = await resultIdOf(created, alice.token);
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: alice.token });
    const invitationId = await resultIdOf(invitation, alice.token);
    const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: bob.token });
    await outcome((accepted.body as Body).operationId as string, bob.token);

    const expense = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 200, date: serverToday, splitBetween: [alice.id, bob.id] },
      token: alice.token,
    });
    await resultIdOf(expense, alice.token);

    // Bob owes Alice 100; Alice records that Bob paid it in cash, and keeps the id that answer gave.
    const settled = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 100 },
      token: alice.token,
    });
    const settlementId = await resultIdOf(settled, alice.token);

    const statement = await http.get(`${api}/groups/${groupId}/members/${bob.id}/statement`, { token: bob.token });
    expect(statement.status).toBe(200);
    expect((statement.body as { entries: unknown[] }).entries).toContainEqual(
      expect.objectContaining({ kind: 'settlement', settlementId, paid: 100, share: 0, balance: 0 }),
    );

    const csv = await http.get(`${api}/groups/${groupId}/members/${bob.id}/statement.csv`, { token: bob.token });
    expect(csv.body as string).toContain(`,settlement,${settlementId},Settlement in cash,100,0,0\r\n`);
  });
});
