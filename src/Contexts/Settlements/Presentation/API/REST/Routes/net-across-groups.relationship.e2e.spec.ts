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
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'net-across-relationship-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
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
  const email = `net-across-relationship-${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group in Groups, and answers the id the request was answered with. */
async function createGroup(owner: { token: string }, name: string, currency: string) {
  const answer = await http.request('POST', `${api}/groups`, { body: { name, currency }, token: owner.token });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** A member of the group invites someone, who accepts: the new member joins. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

/** Ledger records an expense, split equally between the given members, and answers the expense's id. */
async function recordExpense(token: string, groupId: string, amount: number, between: string[]) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Shared', amount, date: serverToday, splitBetween: between },
    token,
  });
  const done = await outcome((answer.body as Body).operationId as string, token);
  expect(done.body.status).toBe('SUCCESS');
  return (done.body.result as { id: string }).id;
}

/** Asks for a netting as one of the two people does, and follows it to its outcome. */
async function net(token: string, withId: string, currency: string) {
  const answer = await http.request('POST', `${api}/nettings`, { body: { with: withId, currency }, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: done.body.status as string, body: done.body };
}

describe('Groups → Settlements (GroupCurrency, SettlementMembers): a group Groups makes is the one Settlements reads, by the id it answered', () => {
  it('finds the group by the id Groups answered, with its members, and not at all for someone outside it', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const carl = await person('Carl');
    const groupId = await createGroup(ann, 'Flat', 'EUR');
    await join(groupId, ann, bob);

    const suggested = await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: bob.token });
    expect(suggested.status).toBe(200);
    expect(suggested.body).toEqual([]);

    const outside = await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: carl.token });
    expect(outside.status).toBe(404);
  });
});

describe('Ledger → Settlements (GroupBalances): a balance Ledger records is the one Settlements reads, by the group id it was recorded in', () => {
  it('suggests the transfer an expense Ledger recorded in the group leaves, found by the group id', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await createGroup(ann, 'Flat', 'EUR');
    await join(groupId, ann, bob);
    await recordExpense(ann.token, groupId, 60, [ann.id, bob.id]);

    const suggested = await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: bob.token });
    expect(suggested.status).toBe(200);
    expect(suggested.body).toEqual([{ from: bob.id, to: ann.id, amount: 30 }]);
  });
});

describe("Settlements → Ledger (SettledAmounts, SettlementAudit): a netting Settlements makes is one Ledger's statement lists, by the id it answered", () => {
  it('lists the settlement a netting made as "Settlement by netting" in the member statement of its group', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const flat = await createGroup(bob, 'Flat', 'EUR');
    await join(flat, bob, ann);
    const club = await createGroup(ann, 'Club', 'EUR');
    await join(club, ann, bob);
    // Ann owes Bob 300 in the flat, and Bob owes Ann 400 in the club: 300 is netted, one settlement in each group.
    await recordExpense(bob.token, flat, 600, [ann.id, bob.id]);
    await recordExpense(ann.token, club, 800, [ann.id, bob.id]);

    const netted = await net(ann.token, bob.id, 'EUR');
    expect(netted.status).toBe('SUCCESS');
    const nettingId = (netted.body.result as { id: string }).id;
    const netting = await http.get(`${api}/nettings/${nettingId}`, { token: ann.token });
    const settlementIds = (netting.body as { settlements: string[] }).settlements;

    const statement = await http.get(`${api}/groups/${flat}/members/${ann.id}/statement`, { token: ann.token });
    const entries = (statement.body as { entries: { kind: string; settlementId?: string; description: string }[] })
      .entries;
    const settlementEntries = entries.filter(entry => entry.kind === 'settlement');
    expect(settlementEntries.map(entry => entry.settlementId)).toContain(settlementIds[0]);
    expect(settlementEntries.find(entry => entry.settlementId === settlementIds[0])?.description).toBe(
      'Settlement by netting',
    );
  });
});
