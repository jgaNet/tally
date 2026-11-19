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

type Body = Record<string, unknown>;
type Notice = { id: string; kind: string; groupId: string; expenseId: string; amount: number; at: string };

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
  const email = `${name.toLowerCase()}-notice-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group and answers its id, the operation followed to its outcome. */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** A member of the group invites someone, who accepts: the new member joins, and the operation is followed. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

/** Records an expense, the operation followed to its outcome; answers the expense's id. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return (done.body as { result: { id: string } }).result.id;
}

/** The notices of a person, as they read them. */
async function notices(token?: string) {
  return http.get(`${api}/notices`, { token });
}

/** Waits until the person has `count` notices, the notice being made within a few seconds of the expense. */
async function noticesUntil(token: string, count: number): Promise<Notice[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { body } = await notices(token);
    if ((body as Notice[]).length >= count) return body as Notice[];
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`The notices never reached ${count}`);
}

// An expense dated in the past: the date is the test's, not the machine's clock.
const today = () => '2025-06-01';

describe('Ledger → Notifications (ExpenseRecorded)', () => {
  it('tells each member of the split but the payer their share, under the expense id the recording answered, and tells no one else', async () => {
    const bob = await person('Bob');
    const cy = await person('Cy');
    const groupId = await createGroup(bob);
    await join(groupId, bob, cy);

    const expenseId = await record(bob.token, groupId, {
      description: 'Pizzas',
      amount: 1000,
      date: today(),
      splitBetween: [bob.id, cy.id],
    });

    const forCy = await noticesUntil(cy.token, 1);
    expect(forCy).toEqual([
      { id: expect.any(String), kind: 'expense', groupId, expenseId, amount: 500, at: expect.any(String) },
    ]);
    expect(new Date(forCy[0].at).getTime()).not.toBeNaN();

    const { status, body } = await notices(bob.token);
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });
});

describe('Ledger → Notifications (BudgetPassed)', () => {
  it('tells each member once that the month passed the budget of its category, and the expense that passed it is told under the id its recording answered', async () => {
    const bob = await person('Bob');
    const cy = await person('Cy');
    const groupId = await createGroup(bob);
    await join(groupId, bob, cy);
    const set = await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
      body: { amount: 1000 },
      token: bob.token,
    });
    await outcome((set.body as Body).operationId as string, bob.token);

    const expenseId = await record(bob.token, groupId, {
      description: 'Shopping',
      amount: 1500,
      date: today(),
      category: 'groceries',
      splitBetween: [bob.id, cy.id],
    });

    const forCy = await noticesUntil(cy.token, 2);
    expect(forCy).toEqual(
      expect.arrayContaining([
        { id: expect.any(String), kind: 'expense', groupId, expenseId, amount: 750, at: expect.any(String) },
        {
          id: expect.any(String),
          kind: 'budget',
          groupId,
          category: 'groceries',
          month: '2025-06',
          budget: 1000,
          amount: 1500,
          at: expect.any(String),
        },
      ]),
    );
    const forBob = await noticesUntil(bob.token, 1);
    expect(forBob).toEqual([
      {
        id: expect.any(String),
        kind: 'budget',
        groupId,
        category: 'groceries',
        month: '2025-06',
        budget: 1000,
        amount: 1500,
        at: expect.any(String),
      },
    ]);
  });
});

describe('Ledger → Notifications (ExpenseRecorded and the preference in force when it is recorded)', () => {
  it('tells a member who kept expense notices on by the expense id its recording answered, and tells no one who turned them off', async () => {
    const hal = await person('Hal');
    const ivy = await person('Ivy');
    const jon = await person('Jon');
    const groupId = await createGroup(hal);
    await join(groupId, hal, ivy);
    await join(groupId, hal, jon);
    const off = await http.request('PUT', `${api}/accounts/me/notice-preferences/expense`, {
      body: { enabled: false },
      token: jon.token,
    });
    await outcome((off.body as Body).operationId as string, jon.token);

    const expenseId = await record(hal.token, groupId, {
      description: 'Tea',
      amount: 900,
      date: today(),
      splitBetween: [hal.id, ivy.id, jon.id],
    });

    const forIvy = await noticesUntil(ivy.token, 1);
    expect(forIvy).toEqual([
      { id: expect.any(String), kind: 'expense', groupId, expenseId, amount: 300, at: expect.any(String) },
    ]);
    const forJon = await http.get(`${api}/notices`, { token: jon.token });
    expect(forJon.body).toEqual([]);
  });
});
