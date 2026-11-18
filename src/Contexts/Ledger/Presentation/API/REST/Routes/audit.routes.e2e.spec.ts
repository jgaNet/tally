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
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'audit-clock@example.com', password: 'correct horse', name: 'Clock' },
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
  const email = `${name.toLowerCase()}-audit-${++accountCount}@example.com`;
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

/** The day the server has, which the expenses are dated by (a date too far from it is refused). */
let serverToday = '';
const today = () => serverToday;

/** Sends a command as a client does: the `202`, then the operation followed to its outcome. */
async function send(method: 'POST' | 'PUT' | 'DELETE', path: string, token: string, body?: Body) {
  const answer = await http.request(method, `${api}${path}`, { body, token });
  if (answer.status !== 202) return { status: answer.status, result: undefined as unknown };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: done.body.status, result: (done.body as { result?: { id: string } }).result };
}

async function auditOf(groupId: string, token?: string) {
  return http.get(`${api}/groups/${groupId}/audit`, { token });
}

describe('the audit of money changes (request 28)', () => {
  it('writes each change of money, and a member reads them, the oldest first', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);

    const recorded = await send('POST', `/groups/${groupId}/expenses`, ann.token, {
      description: 'Dinner',
      amount: 60,
      date: today(),
      splitBetween: [ann.id, bob.id],
    });
    expect(recorded.status).toBe('SUCCESS');
    const expenseId = (recorded.result as { id: string }).id;

    const settled = await send('POST', `/groups/${groupId}/settlements/cash`, ann.token, { from: bob.id, amount: 30 });
    expect(settled.status).toBe('SUCCESS');
    const settlementId = (settled.result as { id: string }).id;

    const edited = await send('PUT', `/expenses/${expenseId}`, ann.token, {
      description: 'Dinner',
      amount: 90,
      date: today(),
      splitBetween: [ann.id, bob.id],
      version: 1,
    });
    expect(edited.status).toBe('SUCCESS');

    const deleted = await send('DELETE', `/expenses/${expenseId}`, ann.token);
    expect(deleted.status).toBe('SUCCESS');

    const read = await auditOf(groupId, bob.token);
    expect(read.status).toBe(200);
    const entries = read.body as AuditEntry[];
    expect(entries.map(entry => entry.action)).toEqual(
      expect.arrayContaining(['expense-recorded', 'settlement-paid', 'expense-edited', 'expense-deleted']),
    );
    expect(entries).toHaveLength(4);
    for (let i = 1; i < entries.length; i++) expect(entries[i - 1].at <= entries[i].at).toBe(true);

    expect(entries.find(entry => entry.action === 'expense-recorded')).toMatchObject({
      by: ann.id,
      subjectId: expenseId,
      amount: 60,
    });
    expect(entries.find(entry => entry.action === 'settlement-paid')).toMatchObject({
      by: ann.id,
      subjectId: settlementId,
      amount: 30,
    });
    expect(entries.find(entry => entry.action === 'expense-edited')).toMatchObject({
      by: ann.id,
      subjectId: expenseId,
      amount: 90,
    });
    expect(entries.find(entry => entry.action === 'expense-deleted')).toMatchObject({
      by: ann.id,
      subjectId: expenseId,
      amount: 90,
    });
  });

  it('answers a refused change no entry, and a stranger that the group does not exist', async () => {
    const ann = await person('Ann');
    const cy = await person('Cy');
    const groupId = await createGroup(ann);
    const before = (await auditOf(groupId, ann.token)).body as AuditEntry[];
    expect(before).toEqual([]);

    const refused = await send('POST', `/groups/${groupId}/settlements/cash`, ann.token, { from: cy.id, amount: 5 });
    expect(refused.status).not.toBe('SUCCESS');
    expect((await auditOf(groupId, ann.token)).body as AuditEntry[]).toEqual([]);

    const stranger = await auditOf(groupId, cy.token);
    expect(stranger.status).toBe(404);
  });

  it('refuses a read without a caller', async () => {
    const ann = await person('Ann');
    const groupId = await createGroup(ann);
    const { status } = await auditOf(groupId);
    expect(status).toBe(401);
  });
});
