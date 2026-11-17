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

describe('notices of an expense', () => {
  it('lists a member’s notices the most recent first, and gives none for an expense they paid', async () => {
    const bob = await person('Bob');
    const cy = await person('Cy');
    const groupId = await createGroup(bob);
    await join(groupId, bob, cy);

    const first = await record(bob.token, groupId, {
      description: 'Pizzas',
      amount: 1000,
      date: today(),
      splitBetween: [bob.id, cy.id],
    });
    const second = await record(cy.token, groupId, {
      description: 'Drinks',
      amount: 300,
      date: today(),
      splitBetween: [bob.id, cy.id],
    });

    // Cy is told of Bob's expense only; Bob, of Cy's expense only.
    const forCy = await noticesUntil(cy.token, 1);
    const forBob = await noticesUntil(bob.token, 1);
    expect(forCy.map(notice => notice.expenseId)).toEqual([first]);
    expect(forBob.map(notice => [notice.expenseId, notice.amount])).toEqual([[second, 150]]);
  });

  it('keeps a notice after its member leaves the group, and answers 401 to a caller not signed in', async () => {
    const bob = await person('Bob');
    const cy = await person('Cy');
    const groupId = await createGroup(bob);
    await join(groupId, bob, cy);
    await record(bob.token, groupId, {
      description: 'Pizzas',
      amount: 1000,
      date: today(),
      splitBetween: [bob.id, cy.id],
    });
    await noticesUntil(cy.token, 1);

    // Cy paid 1000 split with Bob, which is what Cy owes of Bob's expense: Cy's balance is 0, and Cy may leave.
    await record(cy.token, groupId, {
      description: 'Coffee',
      amount: 1000,
      date: today(),
      splitBetween: [bob.id, cy.id],
    });
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: cy.token });
    const done = await outcome((left.body as Body).operationId as string, cy.token);
    expect(done.body).toMatchObject({ status: 'SUCCESS' });
    const { status, body } = await notices(cy.token);
    expect(status).toBe(200);
    expect(body).toHaveLength(1);

    const anonymous = await notices();
    expect(anonymous.status).toBe(401);
  });
});
