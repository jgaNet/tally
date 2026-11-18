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
type Entry = { id: string; at: string; by: string; action: string; subjectId: string; amount: number };

/** Follows an operation to its end, as a client answered 202 does. */
async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** Signs someone up and in, under the email given: their account's id, and the token that names it. */
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

/** Creates a group and follows its operation: the operation's result is the group's id. */
async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** Joins a group by an invitation, following the operation of the join. */
async function join(token: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: joiner });
  await outcome((accepted.body as { operationId: string }).operationId, joiner);
}

const DAY = '2026-03-10';

/** Records an expense split between the given members, and follows its operation: SUCCESS with the id. */
async function record(token: string, groupId: string, amount: number, splitBetween: string[]): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token,
    body: { description: 'Dinner', date: DAY, amount, splitBetween },
  });
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Edits an expense from the version read, and follows its operation. */
async function edit(token: string, expenseId: string, amount: number, splitBetween: string[], version: number) {
  const answer = await http.request('PUT', `${api}/expenses/${expenseId}`, {
    token,
    body: { description: 'Dinner', date: DAY, amount, splitBetween, version },
  });
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Deletes an expense, and follows its operation. */
async function remove(token: string, expenseId: string): Promise<Operation> {
  const answer = await http.request('DELETE', `${api}/expenses/${expenseId}`, { token });
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Records a payment in cash the token's member received from `from`, and follows its operation: the settlement's id. */
async function settleInCash(token: string, groupId: string, from: string, amount: number): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
    token,
    body: { from, amount },
  });
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Leaves a group, following the operation of the leave. */
async function leave(token: string, groupId: string): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/leave`, { token });
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Reads the group's audit as the given caller reads it. */
async function audit(token: string | undefined, groupId: string) {
  return http.get(`${api}/groups/${groupId}/audit`, { token });
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe('Ledger: the audit of the expenses', () => {
  it('writes an entry for each change of an expense, the oldest first, and never changes one', async () => {
    const ann = await signedIn('audit-expenses-ann@example.com', 'Ann');
    const bob = await signedIn('audit-expenses-bob@example.com', 'Bob');
    const groupId = await createGroup(ann.token, 'Dinner club');
    await join(ann.token, groupId, bob.token);

    const recorded = await record(ann.token, groupId, 6000, [ann.id, bob.id]);
    expect(recorded).toMatchObject({ status: 'SUCCESS' });
    const expenseId = recorded.result as string;
    expect(await edit(ann.token, expenseId, 9000, [ann.id, bob.id], 1)).toMatchObject({ status: 'SUCCESS' });
    expect(await remove(ann.token, expenseId)).toMatchObject({ status: 'SUCCESS' });

    const answer = await audit(ann.token, groupId);
    expect(answer.status).toBe(200);
    const entries = answer.body as Entry[];
    expect(entries.map(entry => [entry.action, entry.by, entry.subjectId, entry.amount])).toEqual([
      ['expense-recorded', ann.id, expenseId, 6000],
      ['expense-edited', ann.id, expenseId, 9000],
      ['expense-deleted', ann.id, expenseId, 9000],
    ]);
    for (const entry of entries) {
      expect(entry.id).toEqual(expect.any(String));
      expect(entry.at).toMatch(ISO_TIME);
    }
    expect(entries.map(entry => entry.at)).toEqual([...entries.map(entry => entry.at)].sort());

    // A member who is not in the group does not see that it exists.
    const carl = await signedIn('audit-expenses-carl@example.com', 'Carl');
    expect(await audit(carl.token, groupId)).toMatchObject({ status: 404 });
    expect(await audit(undefined, groupId)).toMatchObject({ status: 401 });
  });
});

describe('Settlements → Ledger (SettlementAudit)', () => {
  it('shows a settlement in cash the balances start to count, by the payee who recorded it', async () => {
    const ann = await signedIn('audit-cash-ann@example.com', 'Ann');
    const bob = await signedIn('audit-cash-bob@example.com', 'Bob');
    const groupId = await createGroup(ann.token, 'Flat');
    await join(ann.token, groupId, bob.token);
    await record(ann.token, groupId, 3000, [ann.id, bob.id]);

    const settled = await settleInCash(ann.token, groupId, bob.id, 1500);
    expect(settled).toMatchObject({ status: 'SUCCESS' });

    const entries = (await audit(bob.token, groupId)).body as Entry[];
    expect(entries.filter(entry => entry.action === 'settlement-paid')).toEqual([
      expect.objectContaining({ by: ann.id, subjectId: settled.result, amount: 1500 }),
    ]);
  });
});

describe('Groups → Ledger (PassedBalances)', () => {
  it('shows the balance a member passed to the owner when they left, as they left it', async () => {
    const ann = await signedIn('audit-leave-ann@example.com', 'Ann');
    const bob = await signedIn('audit-leave-bob@example.com', 'Bob');
    const groupId = await createGroup(ann.token, 'Trip');
    await join(ann.token, groupId, bob.token);
    await record(ann.token, groupId, 3000, [ann.id, bob.id]);

    expect(await leave(bob.token, groupId)).toMatchObject({ status: 'SUCCESS' });

    const entries = (await audit(ann.token, groupId)).body as Entry[];
    expect(entries.filter(entry => entry.action === 'balance-passed')).toEqual([
      expect.objectContaining({ by: bob.id, subjectId: bob.id, amount: -1500 }),
    ]);
  });
});
