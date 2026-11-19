import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const WEEK = 604_800_000;

// The application's now is the test's: the job reads it, so a week can pass without waiting for one.
let now = new Date('2030-03-01T09:00:00Z');
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  app = await createApplication({ clock: () => now });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});

afterAll(() => app.stop());

type Body = Record<string, unknown>;
type Notice = { id: string; kind: string; groupId: string; expenseId?: string; amount: number; at: string };

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
  const email = `${name.toLowerCase()}-reminder-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group in `currency` and answers its id. */
async function createGroup(owner: { token: string }, currency = 'EUR') {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency },
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

/** Records an expense the caller paid, the operation followed to its outcome. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  await outcome((answer.body as Body).operationId as string, token);
}

/** Records a cash settlement as the payee does, and follows it to its outcome. */
async function settleInCash(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { body, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return (done.body as Body).status;
}

/** The reminders a person has, as they read their notices. */
async function reminders(token: string): Promise<Notice[]> {
  const { body } = await http.get(`${api}/notices`, { token });
  return (body as Notice[]).filter(notice => notice.kind === 'reminder');
}

describe('Reminders (request 18): the background job reminds a member who owes over 2000 for a period, once a period', () => {
  it('notes a debt at the run that sees it, reminds it a period later and once a period while it lasts, and stops at 2000 or less', async () => {
    const bob = await person('Bob');
    const cy = await person('Cy');
    const groupId = await createGroup(bob);
    await join(groupId, bob, cy);
    // Bob paid 5000 for the two of them: Cy owes 2500 of it, over 2000.
    await record(bob.token, groupId, {
      description: 'Dinner',
      amount: 5000,
      date: '2025-06-01',
      splitBetween: [bob.id, cy.id],
    });

    await app.runJobs();
    expect(await reminders(cy.token)).toEqual([]);

    now = new Date(now.getTime() + WEEK - 1);
    await app.runJobs();
    expect(await reminders(cy.token)).toEqual([]);

    now = new Date(now.getTime() + 1);
    await app.runJobs();
    expect(await reminders(cy.token)).toEqual([
      { id: expect.any(String), kind: 'reminder', groupId, amount: 2500, at: now.toISOString() },
    ]);
    // The same run again is the same period: no second reminder.
    await app.runJobs();
    expect(await reminders(cy.token)).toHaveLength(1);

    // A period later, the debt still lasting: a second reminder.
    now = new Date(now.getTime() + WEEK);
    await app.runJobs();
    expect(await reminders(cy.token)).toHaveLength(2);

    // Cy pays Bob in cash, and the debt is gone: the next run clears it, and no reminder follows a period later.
    expect(await settleInCash(bob.token, groupId, { from: cy.id, amount: 2500 })).toBe('SUCCESS');
    await app.runJobs();
    now = new Date(now.getTime() + WEEK);
    await app.runJobs();
    expect(await reminders(cy.token)).toHaveLength(2);

    // A reminder names no expense, and Bob, who owes nothing, has none.
    expect((await reminders(cy.token))[0]).not.toHaveProperty('expenseId');
    expect(await reminders(bob.token)).toEqual([]);
  });

  it('never reminds a debt of 2000 or less, however long it lasts', async () => {
    const dan = await person('Dan');
    const eve = await person('Eve');
    const groupId = await createGroup(dan);
    await join(groupId, dan, eve);
    // Dan paid 3000 for the two of them: Eve owes 1500, which is not over 2000.
    await record(dan.token, groupId, {
      description: 'Groceries',
      amount: 3000,
      date: '2025-06-01',
      splitBetween: [dan.id, eve.id],
    });

    await app.runJobs();
    now = new Date(now.getTime() + 2 * WEEK);
    await app.runJobs();
    expect(await reminders(eve.token)).toEqual([]);
  });
});

describe('Settlements → Notifications (OutstandingDebts): the debt a settlement reduces is the one the reminder is for, in the group the request answered', () => {
  it('reminds what is still owed after a cash settlement Settlements recorded, in the group the create request answered', async () => {
    const bob = await person('Bob');
    const cy = await person('Cy');
    const groupId = await createGroup(bob);
    await join(groupId, bob, cy);
    await record(bob.token, groupId, {
      description: 'Dinner',
      amount: 5000,
      date: '2025-06-01',
      splitBetween: [bob.id, cy.id],
    });
    await app.runJobs();

    // Bob records that Cy paid 400 of the 2500 Cy owed: Settlements keeps the settlement under the id its request answered.
    const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: cy.id, amount: 400 },
      token: bob.token,
    });
    const settled = await outcome((answer.body as Body).operationId as string, bob.token);
    const settlementId = (settled.body as { result: { id: string } }).result.id;
    const kept = await http.get(`${api}/settlements/${settlementId}`, { token: bob.token });
    expect(kept.status).toBe(200);

    // A period later, the debt still lasting, the reminder is for what is still owed: 2100, still over the threshold.
    now = new Date(now.getTime() + WEEK);
    await app.runJobs();
    expect(await reminders(cy.token)).toEqual([expect.objectContaining({ kind: 'reminder', groupId, amount: 2100 })]);
  });

  it('reminds a debt over 20 yen in a group in yen, in yen, and never a debt of 20 yen (request 40)', async () => {
    const bob = await person('Bob');
    const cy = await person('Cy');
    const yen = await createGroup(bob, 'JPY');
    await join(yen, bob, cy);
    // Bob paid 4002 yen for the two of them: Cy owes 2001 yen, over the 20 yen a debt must be over in yen.
    await record(bob.token, yen, {
      description: 'Sushi',
      amount: 4002,
      date: '2025-06-01',
      splitBetween: [bob.id, cy.id],
    });
    // Cy owes exactly 20 yen in a second group in yen: not over it, so it is never noted nor reminded.
    const small = await createGroup(bob, 'JPY');
    await join(small, bob, cy);
    await record(bob.token, small, {
      description: 'Tea',
      amount: 40,
      date: '2025-06-01',
      splitBetween: [bob.id, cy.id],
    });
    await app.runJobs();

    now = new Date(now.getTime() + WEEK);
    await app.runJobs();
    const notices = (await reminders(cy.token)).filter(notice => notice.groupId === yen || notice.groupId === small);
    expect(notices).toEqual([expect.objectContaining({ kind: 'reminder', groupId: yen, amount: 2001 })]);
  });
});
