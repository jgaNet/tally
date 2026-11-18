import { jest } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

/** The instant the test starts at, the 18th of November 2026: the system clock reads the faked Date. */
const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
/** Today in UTC, the day the expenses of these tests are spent on. */
const TODAY = '2026-11-18';

beforeAll(async () => {
  jest.useFakeTimers({
    now: T0,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  jest.useRealTimers();
});

type Operation = { status: string; result?: string; error?: { type: string; message: string } };
type Template = {
  id: string;
  groupId: string;
  name: string;
  splitBetween?: string[];
  splitByShares?: { memberId: string; shares: number }[];
};
type Expense = { id: string; groupId: string; splitKind: string; shares: { memberId: string; amount: number }[] };

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

/** A flat of three: Ann its owner, Ben and Cy its members. */
async function flat(suffix: string) {
  const ann = await signedIn(`template-ann-${suffix}@example.com`, 'Ann');
  const ben = await signedIn(`template-ben-${suffix}@example.com`, 'Ben');
  const cy = await signedIn(`template-cy-${suffix}@example.com`, 'Cy');
  const groupId = await createGroup(ann.token, 'Flat');
  await join(ann.token, groupId, ben.token);
  await join(ann.token, groupId, cy.token);
  return { ann, ben, cy, groupId };
}

/** Saves a template, and reads its operation to the end: the template's id on success, the refusal on an error. */
async function saveTemplate(token: string, groupId: string, body: object): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/templates`, { token, body });
  return outcome((answer.body as { operationId: string }).operationId, token);
}

async function listTemplates(token: string, groupId: string): Promise<Template[]> {
  const { status, body } = await http.get(`${api}/groups/${groupId}/templates`, { token });
  expect(status).toBe(200);
  return body as Template[];
}

/** Records an expense, and reads its operation: the expense's id on success. */
async function recordExpense(token: string, groupId: string, body: object): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  return outcome((answer.body as { operationId: string }).operationId, token);
}

async function expenseOf(token: string, expenseId: string): Promise<Expense> {
  const { body } = await http.get(`${api}/expenses/${expenseId}`, { token });
  return body as Expense;
}

describe('split templates (request 25)', () => {
  it('saves a split under a name, and lists it with the split as it was given, the earliest saved first', async () => {
    const { ann, ben, groupId } = await flat('list');

    const first = await saveTemplate(ann.token, groupId, { name: 'Flat', splitBetween: [ann.id, ben.id] });
    const second = await saveTemplate(ann.token, groupId, {
      name: 'Big room',
      splitByShares: [
        { memberId: ann.id, shares: 2 },
        { memberId: ben.id, shares: 1 },
      ],
    });

    expect(first).toMatchObject({ status: 'SUCCESS' });
    expect(second.status).toBe('SUCCESS');
    expect(await listTemplates(ben.token, groupId)).toEqual([
      { id: first.result, groupId, name: 'Flat', splitBetween: [ann.id, ben.id] },
      {
        id: second.result,
        groupId,
        name: 'Big room',
        splitByShares: [
          { memberId: ann.id, shares: 2 },
          { memberId: ben.id, shares: 1 },
        ],
      },
    ]);
  });

  it('refuses a name taken in the group, whatever its case, and a split of a member who is not in the group', async () => {
    const { ann, ben, cy, groupId } = await flat('refusals');
    expect((await saveTemplate(ann.token, groupId, { name: 'Rent', splitBetween: [ann.id, ben.id] })).status).toBe(
      'SUCCESS',
    );

    const taken = await saveTemplate(ben.token, groupId, { name: 'rent', splitBetween: [ben.id, cy.id] });
    expect(taken).toMatchObject({ status: 'ERROR', error: { type: 'TemplateNameTaken' } });

    const stranger = await signedIn(`template-stranger-refusals@example.com`, 'Stranger');
    const outsider = await saveTemplate(ann.token, groupId, { name: 'Outside', splitBetween: [ann.id, stranger.id] });
    expect(outsider).toMatchObject({ status: 'ERROR', error: { type: 'NotAMemberOfTheGroup' } });
  });

  it('answers a body of neither split, or of both, and a split by exact amounts, as a body of the wrong shape', async () => {
    const { ann, ben, groupId } = await flat('shape');
    const neither = await http.request('POST', `${api}/groups/${groupId}/templates`, {
      token: ann.token,
      body: { name: 'Neither' },
    });
    const both = await http.request('POST', `${api}/groups/${groupId}/templates`, {
      token: ann.token,
      body: { name: 'Both', splitBetween: [ann.id], splitByShares: [{ memberId: ben.id, shares: 1 }] },
    });
    const exact = await http.request('POST', `${api}/groups/${groupId}/templates`, {
      token: ann.token,
      body: { name: 'Exact', splitExactly: [{ memberId: ann.id, amount: 10 }] },
    });

    expect([neither.status, both.status, exact.status]).toEqual([400, 400, 400]);
  });

  it('answers a non-member the group does not exist, when listing its templates', async () => {
    const { ann, groupId } = await flat('visibility');
    const outsider = await signedIn('template-outsider-visibility@example.com', 'Outsider');

    const { status } = await http.get(`${api}/groups/${groupId}/templates`, { token: outsider.token });
    expect(status).toBe(404);
    expect(await listTemplates(ann.token, groupId)).toEqual([]);
  });

  it('splits an expense by a template as if its split had been given, and keeps the shares when the template changes', async () => {
    const { ann, ben, cy, groupId } = await flat('expense');
    const saved = await saveTemplate(ann.token, groupId, { name: 'Flat', splitBetween: [ann.id, ben.id] });

    const recorded = await recordExpense(ann.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: TODAY,
      template: saved.result,
    });
    expect(recorded.status).toBe('SUCCESS');
    const expense = await expenseOf(ann.token, recorded.result as string);
    expect(expense.splitKind).toBe('equal');
    expect(expense.shares).toEqual([
      { memberId: ann.id, amount: 500 },
      { memberId: ben.id, amount: 500 },
    ]);

    const replaced = await http.request('PUT', `${api}/templates/${saved.result}`, {
      token: ann.token,
      body: { name: 'Flat', splitBetween: [ann.id, ben.id, cy.id] },
    });
    expect(replaced.status).toBe(202);
    expect((await outcome((replaced.body as { operationId: string }).operationId, ann.token)).status).toBe('SUCCESS');

    expect((await expenseOf(ann.token, expense.id)).shares).toEqual(expense.shares);
  });

  it('refuses an expense split by a template whose payer is not among its members', async () => {
    const { ann, ben, groupId } = await flat('payer');
    const saved = await saveTemplate(ben.token, groupId, { name: 'Ben alone', splitBetween: [ben.id] });

    const refused = await recordExpense(ann.token, groupId, {
      description: 'Dinner',
      amount: 900,
      date: TODAY,
      template: saved.result,
    });
    expect(refused).toMatchObject({ status: 'ERROR', error: { type: 'PayerNotInSplit' } });
  });

  it('refuses an expense given a template of another group, as not found', async () => {
    const { ann, ben, groupId } = await flat('elsewhere');
    const other = await createGroup(ben.token, 'Elsewhere');
    const saved = await saveTemplate(ben.token, other, { name: 'Elsewhere', splitBetween: [ben.id] });

    const refused = await recordExpense(ann.token, groupId, {
      description: 'Tea',
      amount: 300,
      date: TODAY,
      template: saved.result,
    });
    expect(refused).toMatchObject({ status: 'ERROR', error: { type: 'NotFound' } });
  });

  it('lets the saver or the owner replace a template and remove it, and refuses any other member', async () => {
    const { ann, ben, cy, groupId } = await flat('change');
    const saved = await saveTemplate(ben.token, groupId, { name: 'Ben and Ann', splitBetween: [ben.id, ann.id] });

    const byCy = await http.request('PUT', `${api}/templates/${saved.result}`, {
      token: cy.token,
      body: { name: 'Cy', splitBetween: [cy.id] },
    });
    expect((await outcome((byCy.body as { operationId: string }).operationId, cy.token)).error).toMatchObject({
      type: 'NotTheSaverOrTheOwner',
    });

    const byOwner = await http.request('PUT', `${api}/templates/${saved.result}`, {
      token: ann.token,
      body: { name: 'Ann and Ben', splitBetween: [ann.id, ben.id] },
    });
    expect((await outcome((byOwner.body as { operationId: string }).operationId, ann.token)).status).toBe('SUCCESS');
    expect(await listTemplates(ben.token, groupId)).toEqual([
      { id: saved.result, groupId, name: 'Ann and Ben', splitBetween: [ann.id, ben.id] },
    ]);

    const removedByCy = await http.request('DELETE', `${api}/templates/${saved.result}`, { token: cy.token });
    expect((await outcome((removedByCy.body as { operationId: string }).operationId, cy.token)).error).toMatchObject({
      type: 'NotTheSaverOrTheOwner',
    });

    const removed = await http.request('DELETE', `${api}/templates/${saved.result}`, { token: ben.token });
    expect((await outcome((removed.body as { operationId: string }).operationId, ben.token)).status).toBe('SUCCESS');
    expect(await listTemplates(ben.token, groupId)).toEqual([]);
  });
});

describe('Groups → Ledger', () => {
  it('saves a template and splits an expense by it in a group made in Groups, and finds them by the id Groups answered', async () => {
    const ann = await signedIn('template-rel-ann@example.com', 'Ann');
    const ben = await signedIn('template-rel-ben@example.com', 'Ben');
    // Groups makes the group and answers its id; the membership Ledger reads is the one Groups made.
    const groupId = await createGroup(ann.token, 'Just joined');
    await join(ann.token, groupId, ben.token);

    const saved = await saveTemplate(ben.token, groupId, { name: 'Halves', splitBetween: [ann.id, ben.id] });
    expect(saved).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });
    expect(await listTemplates(ann.token, groupId)).toEqual([
      { id: saved.result, groupId, name: 'Halves', splitBetween: [ann.id, ben.id] },
    ]);

    const recorded = await recordExpense(ann.token, groupId, {
      description: 'Rent',
      amount: 1001,
      date: TODAY,
      template: saved.result,
    });
    expect(recorded.status).toBe('SUCCESS');
    expect(await expenseOf(ann.token, recorded.result as string)).toMatchObject({
      groupId,
      splitKind: 'equal',
      shares: [
        { memberId: ann.id, amount: 501 },
        { memberId: ben.id, amount: 500 },
      ],
    });
  });
});
