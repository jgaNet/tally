import { jest } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { sweepDebts } from '@Bootstrap/Fastify/jobs';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const DAY = 86_400_000;
/** The instant the test starts at. The system clock reads the faked Date, so a test moves time with `jest.setSystemTime`. */
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);

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
type Notice = {
  id: string;
  kind: 'expense' | 'reminder' | 'budget';
  groupId: string;
  expenseId?: string;
  amount: number;
};
type Preference = { kind: string; enabled: boolean };

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

async function setNoticePreference(token: string, kind: string, enabled: boolean): Promise<Operation> {
  const answer = await http.request('PUT', `${api}/accounts/me/notice-preferences/${kind}`, {
    token,
    body: { enabled },
  });
  expect(answer.status).toBe(202);
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** Records an expense paid by `token`, split equally between the members given, in the category given; answers the expense's id. */
async function record(
  token: string,
  groupId: string,
  amount: number,
  members: string[],
  extra: { category?: string } = {},
): Promise<string> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token,
    body: { description: 'Holiday', amount, date: '2026-11-10', splitBetween: members, ...extra },
  });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

async function noticesOf(token: string): Promise<Notice[]> {
  const { status, body } = await http.get(`${api}/notices`, { token });
  expect(status).toBe(200);
  return body as Notice[];
}

/** Waits until `person` has a notice of `kind` in `group` (a reaction that has made theirs has made the others' before), then reads all of theirs. */
async function noticesOnceMade(token: string, kind: string, group: string): Promise<Notice[]> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const found = (await noticesOf(token)).filter(notice => notice.kind === kind && notice.groupId === group);
    if (found.length) return found;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`No ${kind} notice was made`);
}

describe('GET and PUT /accounts/me/notice-preferences (request 36)', () => {
  it('reads every kind on, in order, until it is turned off, and answers 401 to a caller who is not signed in', async () => {
    const ann = await signedIn('prefs-read-ann@example.com', 'Ann');

    const read = await http.get(`${api}/accounts/me/notice-preferences`, { token: ann.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);

    const anonymous = await http.get(`${api}/accounts/me/notice-preferences`);
    expect(anonymous.status).toBe(401);
    const unsigned = await http.request('PUT', `${api}/accounts/me/notice-preferences/budget`, {
      body: { enabled: false },
    });
    expect(unsigned.status).toBe(401);
  });

  it('turns a kind off and on again, for the caller only, and refuses a kind that is not one of the three behind the 202', async () => {
    const ann = await signedIn('prefs-toggle-ann@example.com', 'Ann');
    const ben = await signedIn('prefs-toggle-ben@example.com', 'Ben');

    expect((await setNoticePreference(ann.token, 'budget', false)).status).toBe('SUCCESS');
    const annRead = await http.get(`${api}/accounts/me/notice-preferences`, { token: ann.token });
    expect(annRead.body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: false },
    ]);
    const benRead = await http.get(`${api}/accounts/me/notice-preferences`, { token: ben.token });
    expect((benRead.body as Preference[]).every(preference => preference.enabled)).toBe(true);

    expect((await setNoticePreference(ann.token, 'budget', true)).status).toBe('SUCCESS');
    const again = await http.get(`${api}/accounts/me/notice-preferences`, { token: ann.token });
    expect((again.body as Preference[]).find(preference => preference.kind === 'budget')).toEqual({
      kind: 'budget',
      enabled: true,
    });

    const refused = await setNoticePreference(ann.token, 'pets', false);
    expect(refused).toMatchObject({ status: 'ERROR', error: { type: 'InvalidNoticeKind' } });
  });

  it('refuses a body whose enabled is not a boolean with 400, before anything is asked', async () => {
    const ann = await signedIn('prefs-shape-ann@example.com', 'Ann');

    const answer = await http.request('PUT', `${api}/accounts/me/notice-preferences/expense`, {
      token: ann.token,
      body: { enabled: 'no' },
    });
    expect(answer.status).toBe(400);
  });
});

describe('Ledger → Notifications: a notice of a kind turned off is not made, from then on (request 36)', () => {
  it('finds the expense notice of each member by the id the expense request answered, and not for one who turned them off', async () => {
    const ann = await signedIn('prefs-ledger-ann@example.com', 'Ann');
    const ben = await signedIn('prefs-ledger-ben@example.com', 'Ben');
    const cy = await signedIn('prefs-ledger-cy@example.com', 'Cy');
    const group = await createGroup(ann.token, 'Ledger prefs');
    await join(ann.token, group, ben.token);
    await join(ann.token, group, cy.token);

    await setNoticePreference(ben.token, 'expense', false);
    const expenseId = await record(ann.token, group, 900, [ann.id, ben.id, cy.id]);

    const cyNotices = await noticesOnceMade(cy.token, 'expense', group);
    expect(cyNotices).toEqual([expect.objectContaining({ kind: 'expense', expenseId, amount: 300 })]);
    expect((await noticesOf(ben.token)).filter(notice => notice.kind === 'expense')).toEqual([]);
  });

  it('makes no expense notice for a member who turned it off, from then on, and makes theirs again once it is on', async () => {
    const ann = await signedIn('prefs-expense-ann@example.com', 'Ann');
    const ben = await signedIn('prefs-expense-ben@example.com', 'Ben');
    const cy = await signedIn('prefs-expense-cy@example.com', 'Cy');
    const group = await createGroup(ann.token, 'Expense prefs');
    await join(ann.token, group, ben.token);
    await join(ann.token, group, cy.token);

    // Ben turns expense notices off; the first expense is made after that, so Ben is made none of it.
    await setNoticePreference(ben.token, 'expense', false);
    await record(ann.token, group, 900, [ann.id, ben.id, cy.id]);
    expect((await noticesOnceMade(cy.token, 'expense', group)).map(n => n.amount)).toEqual([300]);
    expect((await noticesOf(ben.token)).filter(notice => notice.kind === 'expense')).toEqual([]);

    // Ben turns them on again: the next expense is made for them, and the first one is not made later.
    await setNoticePreference(ben.token, 'expense', true);
    await record(ann.token, group, 600, [ann.id, ben.id, cy.id]);
    const benNow = await noticesOnceMade(ben.token, 'expense', group);
    expect(benNow.map(n => n.amount)).toEqual([200]);
    expect((await noticesOnceMade(cy.token, 'expense', group)).map(n => n.amount)).toEqual([200, 300]);
  });

  it('tells the others of the group as before when one person turned budget notices off, and tells each once', async () => {
    const ann = await signedIn('prefs-budget-ann@example.com', 'Ann');
    const ben = await signedIn('prefs-budget-ben@example.com', 'Ben');
    const cy = await signedIn('prefs-budget-cy@example.com', 'Cy');
    const group = await createGroup(ann.token, 'Budget prefs');
    await join(ann.token, group, ben.token);
    await join(ann.token, group, cy.token);

    const set = await http.request('PUT', `${api}/groups/${group}/budgets/groceries`, {
      token: ann.token,
      body: { amount: 1000 },
    });
    expect((await outcome((set.body as { operationId: string }).operationId, ann.token)).status).toBe('SUCCESS');

    await setNoticePreference(ben.token, 'budget', false);
    await record(ann.token, group, 1500, [ann.id, ben.id, cy.id], { category: 'groceries' });

    expect(await noticesOnceMade(cy.token, 'budget', group)).toHaveLength(1);
    expect(await noticesOnceMade(ann.token, 'budget', group)).toHaveLength(1);
    expect((await noticesOf(ben.token)).filter(notice => notice.kind === 'budget')).toEqual([]);
  });
});

describe('a reminder not made while reminders are off is made once they are on (request 36, request 18)', () => {
  it('reminds a member who turned reminders off at the first run that finds them on again, and not before', async () => {
    jest.setSystemTime(T0);
    const ann = await signedIn('prefs-reminder-ann@example.com', 'Ann');
    const ben = await signedIn('prefs-reminder-ben@example.com', 'Ben');
    const cy = await signedIn('prefs-reminder-cy@example.com', 'Cy');
    const group = await createGroup(ann.token, 'Reminder prefs');
    await join(ann.token, group, ben.token);
    await join(ann.token, group, cy.token);
    await record(ann.token, group, 9000, [ann.id, ben.id, cy.id]);

    // Ben and Cy each owe 3000 and are noted by the first sweep. Ben turns reminders off.
    await sweepDebts(app);
    await setNoticePreference(ben.token, 'reminder', false);

    // A week on, Cy is reminded; Ben is not, and nothing is recorded for Ben.
    jest.setSystemTime(T0 + 7 * DAY);
    await sweepDebts(app);
    expect(await noticesOnceMade(cy.token, 'reminder', group)).toHaveLength(1);
    expect((await noticesOf(ben.token)).filter(notice => notice.kind === 'reminder')).toEqual([]);

    // Ben turns reminders on a day later: the next run reminds them, as the debt has lasted a week.
    jest.setSystemTime(T0 + 8 * DAY);
    await setNoticePreference(ben.token, 'reminder', true);
    await sweepDebts(app);
    const benReminders = await noticesOnceMade(ben.token, 'reminder', group);
    expect(benReminders).toEqual([expect.objectContaining({ kind: 'reminder', groupId: group, amount: 3000 })]);
  });
});
