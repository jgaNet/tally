import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday = '';

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'audit-relationship-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(() => app.stop());

type Body = Record<string, unknown>;
type AuditEntry = { id: string; at: string; by: string; action: string; subjectId: string; amount: number };

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
  const email = `${name.toLowerCase()}-audit-relationship-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group and answers its id, as a client does. */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
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

/** Sends a command as a client does: the `202`, then the operation followed to its outcome. */
async function send(method: 'POST' | 'PUT' | 'DELETE', path: string, token: string, body?: Body) {
  const answer = await http.request(method, `${api}${path}`, { body, token });
  if (answer.status !== 202) return { status: answer.status, result: undefined as unknown };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: done.body.status, result: (done.body as { result?: { id: string } }).result };
}

describe('Groups → Ledger (PassedBalances): a balance that passed when a member left is an entry Ledger reads, by the member who left', () => {
  it('passes the balance to the owner when a member leaves owing, and reads it in the audit under that member', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);
    const recorded = await send('POST', `/groups/${groupId}/expenses`, ann.token, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });
    expect(recorded.status).toBe('SUCCESS');

    // A leave answers no id: the entry is found by the member who left, the one the request was made for.
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    if (left.status === 202) {
      expect(((await outcome((left.body as Body).operationId as string, bob.token)).body as Body).status).toBe(
        'SUCCESS',
      );
    } else {
      expect(left.status).toBeLessThan(300);
    }

    const read = await http.get(`${api}/groups/${groupId}/audit`, { token: ann.token });
    expect(read.status).toBe(200);
    expect((read.body as AuditEntry[]).find(entry => entry.action === 'balance-passed')).toMatchObject({
      by: bob.id,
      subjectId: bob.id,
      amount: -30,
    });
  });
});

describe('Settlements → Ledger (SettlementAudit): a settlement Settlements paid is an entry Ledger reads, by the id the recording answered', () => {
  it('records a cash settlement and finds its entry in the audit by the id the request answered', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);
    await send('POST', `/groups/${groupId}/expenses`, ann.token, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });

    const settled = await send('POST', `/groups/${groupId}/settlements/cash`, ann.token, { from: bob.id, amount: 30 });
    expect(settled.status).toBe('SUCCESS');
    const settlementId = (settled.result as { id: string }).id;

    const read = await http.get(`${api}/groups/${groupId}/audit`, { token: bob.token });
    expect(read.status).toBe(200);
    expect((read.body as AuditEntry[]).find(entry => entry.subjectId === settlementId)).toMatchObject({
      action: 'settlement-paid',
      by: ann.id,
      amount: 30,
    });
  });
});
