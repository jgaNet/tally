import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application's now is the test's: the background job reads it, so a month can pass without waiting for one.
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
  const email = `${name.toLowerCase()}-recurring-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group the owner made, and answers its id. */
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

/** Sets up a recurring expense, and answers its outcome as the operation ends. */
async function setUp(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/recurring`, { body, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return done.body as { status: string; result?: { id: string }; error?: { type: string } };
}

/** The expenses of a group, once the job's reactions have run: the dates of them, the latest first. */
async function expenseDates(token: string, groupId: string): Promise<string[]> {
  const { body } = await http.get(`${api}/groups/${groupId}/expenses`, { token });
  return (body as { date: string }[]).map(expense => expense.date);
}

describe('recurring expenses (request 23)', () => {
  test('a member sets one up, and reads it and the group’s, the earliest set up first', async () => {
    const owner = await person('Owner');
    const groupId = await createGroup(owner);
    const first = await setUp(owner.token, groupId, {
      description: 'Rent',
      amount: 90000,
      startsOn: '2030-03-05',
      splitBetween: [owner.id],
    });
    const second = await setUp(owner.token, groupId, {
      description: 'Internet',
      amount: 3000,
      startsOn: '2030-03-10',
      splitExactly: [{ memberId: owner.id, amount: 3000 }],
    });
    expect(first.status).toBe('SUCCESS');
    expect(second.status).toBe('SUCCESS');

    const read = await http.get(`${api}/recurring/${first.result?.id}`, { token: owner.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id: first.result?.id,
      groupId,
      paidBy: owner.id,
      description: 'Rent',
      amount: 90000,
      startsOn: '2030-03-05',
      next: '2030-03-05',
      splitBetween: [owner.id],
    });

    const listed = await http.get(`${api}/groups/${groupId}/recurring`, { token: owner.token });
    expect(listed.status).toBe(200);
    expect((listed.body as { description: string }[]).map(recurring => recurring.description)).toEqual([
      'Rent',
      'Internet',
    ]);
    expect((listed.body as { splitExactly: unknown }[])[1].splitExactly).toEqual([
      { memberId: owner.id, amount: 3000 },
    ]);
  });

  test('records each day that has come once, the days passed at its first run, and not twice', async () => {
    now = new Date('2030-03-01T09:00:00Z');
    const owner = await person('Payer');
    const groupId = await createGroup(owner);
    const other = await person('Mate');
    await join(groupId, owner, other);
    const set = await setUp(owner.token, groupId, {
      description: 'Rent',
      amount: 90000,
      startsOn: '2030-02-05',
      splitBetween: [owner.id, other.id],
    });
    const id = set.result?.id as string;

    // Set up with a start already passed: the expense of its day is recorded at the next run, and not before.
    expect(await expenseDates(owner.token, groupId)).toEqual([]);
    await app.runJobs();
    await app.runJobs();
    expect(await expenseDates(owner.token, groupId)).toEqual(['2030-02-05']);
    expect((await http.get(`${api}/recurring/${id}`, { token: owner.token })).body).toMatchObject({
      next: '2030-03-05',
    });

    // On its day, the next run records it; every run after that, the same day is not recorded twice.
    now = new Date('2030-03-05T10:00:00Z');
    await app.runJobs();
    await app.runJobs();
    expect(await expenseDates(owner.token, groupId)).toEqual(['2030-03-05', '2030-02-05']);
    expect((await http.get(`${api}/recurring/${id}`, { token: owner.token })).body).toMatchObject({
      next: '2030-04-05',
    });

    const { body } = await http.get(`${api}/groups/${groupId}/expenses`, { token: owner.token });
    const [latest] = body as { paidBy: string; amount: number; shares: { memberId: string; amount: number }[] }[];
    expect(latest.paidBy).toBe(owner.id);
    expect(latest.amount).toBe(90000);
    expect(latest.shares).toEqual([
      { memberId: owner.id, amount: 45000 },
      { memberId: other.id, amount: 45000 },
    ]);
  });

  test('ends when a member of its split has left, and records nothing for that day', async () => {
    now = new Date('2030-03-01T09:00:00Z');
    const owner = await person('Stayer');
    const groupId = await createGroup(owner);
    const leaver = await person('Leaver');
    await join(groupId, owner, leaver);
    const set = await setUp(leaver.token, groupId, {
      description: 'Subscription',
      amount: 1200,
      startsOn: '2030-02-20',
      splitBetween: [leaver.id, owner.id],
    });
    expect(set.status).toBe('SUCCESS');

    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: leaver.token });
    expect((await outcome((left.body as Body).operationId as string, leaver.token)).body).toMatchObject({
      status: 'SUCCESS',
    });

    now = new Date('2030-03-25T09:00:00Z');
    await app.runJobs();
    expect((await http.get(`${api}/recurring/${set.result?.id}`, { token: owner.token })).status).toBe(404);
    expect(await expenseDates(owner.token, groupId)).toEqual([]);
  });

  test('is stopped by its payer or the owner, not by another member; the expenses it recorded stay', async () => {
    now = new Date('2030-03-01T09:00:00Z');
    const owner = await person('Boss');
    const groupId = await createGroup(owner);
    const member = await person('Member');
    await join(groupId, owner, member);
    const set = await setUp(member.token, groupId, {
      description: 'Gym',
      amount: 4000,
      startsOn: '2030-02-15',
      splitBetween: [member.id, owner.id],
    });
    const id = set.result?.id as string;
    await app.runJobs();
    expect(await expenseDates(owner.token, groupId)).toEqual(['2030-02-15']);

    const bystander = await person('Bystander');
    await join(groupId, owner, bystander);
    const byOther = await http.request('DELETE', `${api}/recurring/${id}`, { token: bystander.token });
    expect((await outcome((byOther.body as Body).operationId as string, bystander.token)).body).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotAllowedToStopRecurringExpense' },
    });

    const stopped = await http.request('DELETE', `${api}/recurring/${id}`, { token: member.token });
    expect((await outcome((stopped.body as Body).operationId as string, member.token)).body).toMatchObject({
      status: 'SUCCESS',
    });
    expect((await http.get(`${api}/recurring/${id}`, { token: member.token })).status).toBe(404);
    now = new Date('2030-04-20T09:00:00Z');
    await app.runJobs();
    expect(await expenseDates(owner.token, groupId)).toEqual(['2030-02-15']);
  });

  test('refuses a day after the 28th of its month, a start more than a year away, and an amount that is not one', async () => {
    now = new Date('2030-03-01T09:00:00Z');
    const owner = await person('Strict');
    const groupId = await createGroup(owner);
    const refusals = await Promise.all([
      setUp(owner.token, groupId, {
        description: 'Late',
        amount: 100,
        startsOn: '2030-03-29',
        splitBetween: [owner.id],
      }),
      setUp(owner.token, groupId, {
        description: 'Far',
        amount: 100,
        startsOn: '2031-06-01',
        splitBetween: [owner.id],
      }),
      setUp(owner.token, groupId, { description: 'Free', amount: 0, startsOn: '2030-03-05', splitBetween: [owner.id] }),
    ]);
    expect(refusals.map(refusal => refusal.error?.type)).toEqual([
      'InvalidStartsOn',
      'InvalidStartsOn',
      'InvalidAmount',
    ]);
  });
});

describe('Groups → Ledger (GroupMembers): a recurring expense is set up in the group Groups made, and read back by the id it answered', () => {
  test('the group that answered its id is the one the recurring expense is listed in, and a member who left is no longer in its split', async () => {
    now = new Date('2030-03-01T09:00:00Z');
    const owner = await person('Relation');
    const groupId = await createGroup(owner);
    const joiner = await person('Joiner');
    await join(groupId, owner, joiner);
    const set = await setUp(joiner.token, groupId, {
      description: 'Garden',
      amount: 6000,
      startsOn: '2030-02-10',
      splitBetween: [joiner.id, owner.id],
    });
    const id = set.result?.id as string;

    const listed = await http.get(`${api}/groups/${groupId}/recurring`, { token: owner.token });
    expect(listed.body).toEqual([expect.objectContaining({ id, groupId, paidBy: joiner.id })]);

    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: joiner.token });
    await outcome((left.body as Body).operationId as string, joiner.token);
    await app.runJobs();
    expect((await http.get(`${api}/recurring/${id}`, { token: owner.token })).status).toBe(404);
  });
});
