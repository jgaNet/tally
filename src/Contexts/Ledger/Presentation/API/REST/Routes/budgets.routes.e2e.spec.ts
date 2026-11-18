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
type Notice = { kind: string; groupId: string; category?: string; month?: string; budget?: number; amount: number };

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
  const email = `${name.toLowerCase()}-budget-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group with its owner, and has the other person join it: answers the group's id. */
async function groupWith(owner: { token: string }, other: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (
    (await outcome((answer.body as Body).operationId as string, owner.token)).body as {
      result: { id: string };
    }
  ).result.id;
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: other.token });
  await outcome((accepted.body as Body).operationId as string, other.token);
  return groupId;
}

/** Records an expense, the operation followed to its outcome. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  return outcome((answer.body as Body).operationId as string, token);
}

/** Waits until the person has `count` budget notices, or gives up after a few seconds. */
async function noticesUntil(token: string, count: number): Promise<Notice[]> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const { body } = await http.get(`${api}/notices`, { token });
    const budgets = (body as Notice[]).filter(notice => notice.kind === 'budget');
    if (budgets.length >= count) return budgets;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The notices never came');
}

// Expenses dated in the past: the date is the test's, and the month it is judged in is that month.
const today = () => '2025-06-01';
const thisMonth = () => '2025-06';

describe('budgets (request 24)', () => {
  it('lets the owner set a budget, refuses another member, reads the budgets with what the month spends', async () => {
    const owner = await person('Owner');
    const other = await person('Other');
    const groupId = await groupWith(owner, other);

    const set = await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
      body: { amount: 100 },
      token: owner.token,
    });
    expect(set.status).toBe(202);
    expect(await outcome((set.body as Body).operationId as string, owner.token)).toMatchObject({
      body: { status: 'SUCCESS' },
    });

    const refused = await http.request('PUT', `${api}/groups/${groupId}/budgets/food`, {
      body: { amount: 50 },
      token: other.token,
    });
    expect(await outcome((refused.body as Body).operationId as string, other.token)).toMatchObject({
      body: { status: 'ERROR', error: { type: 'NotAllowedToChangeBudget' } },
    });

    const read = await http.get(`${api}/groups/${groupId}/budgets`, { token: other.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual([{ category: 'groceries', amount: 100, spent: 0 }]);
  });

  it('tells every member once when a month passes a budget, and not again for the same month', async () => {
    const owner = await person('Payer');
    const other = await person('Friend');
    const groupId = await groupWith(owner, other);
    const set = await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
      body: { amount: 100 },
      token: owner.token,
    });
    await outcome((set.body as Body).operationId as string, owner.token);

    const first = await record(owner.token, groupId, {
      description: 'Shop',
      amount: 15000,
      date: today(),
      category: 'groceries',
      splitBetween: [owner.id, other.id],
    });
    expect(first).toMatchObject({ body: { status: 'SUCCESS' } });

    for (const token of [owner.token, other.token]) {
      const notices = await noticesUntil(token, 1);
      expect(notices).toEqual([
        expect.objectContaining({
          kind: 'budget',
          groupId,
          category: 'groceries',
          month: thisMonth(),
          budget: 100,
          amount: 15000,
        }),
      ]);
    }

    await record(owner.token, groupId, {
      description: 'More shopping',
      amount: 1000,
      date: today(),
      category: 'groceries',
      splitBetween: [owner.id, other.id],
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const after = await http.get(`${api}/notices`, { token: owner.token });
    expect((after.body as Notice[]).filter(notice => notice.kind === 'budget')).toHaveLength(1);
    const read = await http.get(`${api}/groups/${groupId}/budgets`, { token: owner.token });
    expect(read.body).toEqual([expect.objectContaining({ category: 'groceries', amount: 100 })]);
  });
});
