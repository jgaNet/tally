import { jest } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { sweepRecurringExpenses } from '@Bootstrap/Fastify/jobs';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

/** The instant the test starts at, the 18th of November 2026. The system clock reads the faked Date, so a test moves time with `jest.setSystemTime`. */
const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);

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
type Recurring = {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  splitBetween?: string[];
  splitExactly?: { memberId: string; amount: number }[];
  splitByShares?: { memberId: string; shares: number }[];
};
type Expense = { id: string; date: string; description: string; amount: number; paidBy: string };

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

/** Signs someone up and in, under the name given: their account's id, and the token that names it. */
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

/** Sets a recurring expense up, and follows its operation: SUCCESS with its id, or ERROR with the refusal. */
async function setUp(token: string, groupId: string, body: object): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/recurring`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** A recurring expense as its payer's or a member's read gives it. */
async function read(token: string, id: string) {
  return http.get(`${api}/recurring/${id}`, { token });
}

/** The expenses the group has, the latest first, as a member reads them. */
async function expenses(token: string, groupId: string): Promise<Expense[]> {
  const { body } = await http.get(`${api}/groups/${groupId}/expenses`, { token });
  return body as Expense[];
}

describe('Recurring expenses (request 23)', () => {
  it('sets one up, answers its id, and reads it with its next day and its split as given', async () => {
    const ann = await signedIn('recurring-read-ann@example.com', 'Ann');
    const ben = await signedIn('recurring-read-ben@example.com', 'Ben');
    const group = await createGroup(ann.token, 'Flat');
    await join(ann.token, group, ben.token);

    // Set up on the day, with its start in the first month of the group's life so the sweep below has nothing to record yet.
    const set = await setUp(ann.token, group, {
      description: 'Rent',
      amount: 90000,
      startsOn: '2026-12-05',
      splitBetween: [ann.id, ben.id],
    });
    expect(set).toMatchObject({ status: 'SUCCESS' });
    const id = set.result as string;

    const read1 = await read(ben.token, id);
    expect(read1.status).toBe(200);
    expect(read1.body).toEqual({
      id,
      groupId: group,
      paidBy: ann.id,
      description: 'Rent',
      amount: 90000,
      startsOn: '2026-12-05',
      next: '2026-12-05',
      splitBetween: [ann.id, ben.id],
    });

    const listed = await http.get(`${api}/groups/${group}/recurring`, { token: ben.token });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([read1.body]);
  });

  it('is refused for a start day that is not one of the 1st to the 28th, or too far away, and for a split with a stranger', async () => {
    const ann = await signedIn('recurring-refuse-ann@example.com', 'Ann');
    const ben = await signedIn('recurring-refuse-ben@example.com', 'Ben');
    const stranger = await signedIn('recurring-refuse-stranger@example.com', 'Stranger');
    const group = await createGroup(ann.token, 'Refusals');
    await join(ann.token, group, ben.token);

    expect(
      await setUp(ann.token, group, {
        description: 'Late',
        amount: 100,
        startsOn: '2026-11-29',
        splitBetween: [ann.id],
      }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'InvalidStartsOn' } });
    expect(
      await setUp(ann.token, group, {
        description: 'Old',
        amount: 100,
        startsOn: '2025-11-01',
        splitBetween: [ann.id],
      }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'StartsOnOutOfRange' } });
    expect(
      await setUp(ann.token, group, {
        description: 'Stranger',
        amount: 100,
        startsOn: '2026-11-05',
        splitBetween: [ann.id, stranger.id],
      }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'NotAMemberOfTheGroup' } });
    // A stranger, not a member, does not see the group at all: the same answer as a group that is not there.
    const notMember = await http.request('POST', `${api}/groups/${group}/recurring`, {
      token: stranger.token,
      body: { description: 'Mine', amount: 100, startsOn: '2026-11-05', splitBetween: [stranger.id] },
    });
    expect(notMember.status).toBe(202);
    expect(await outcome((notMember.body as { operationId: string }).operationId, stranger.token)).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotFound' },
    });
  });

  it('records each day that has come, once, at the sweep: a start long past has each month recorded at the next run', async () => {
    const ann = await signedIn('recurring-sweep-ann@example.com', 'Ann');
    const ben = await signedIn('recurring-sweep-ben@example.com', 'Ben');
    const group = await createGroup(ann.token, 'Sweep');
    await join(ann.token, group, ben.token);

    // Set up on the 18th of November, starting on the 5th of September: September, October and November have come.
    const set = await setUp(ann.token, group, {
      description: 'Internet',
      amount: 3000,
      startsOn: '2026-09-05',
      splitBetween: [ann.id, ben.id],
    });
    const id = set.result as string;
    expect(await expenses(ann.token, group)).toEqual([]);

    await sweepRecurringExpenses(app);
    const recorded = await expenses(ann.token, group);
    expect(recorded.map(expense => expense.date).sort()).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
    expect(recorded).toEqual(
      expect.arrayContaining([expect.objectContaining({ description: 'Internet', amount: 3000, paidBy: ann.id })]),
    );
    expect((await read(ann.token, id)).body).toMatchObject({ next: '2026-12-05' });

    // A sweep again the same day records nothing more: each day has one expense.
    await sweepRecurringExpenses(app);
    expect(await expenses(ann.token, group)).toHaveLength(3);

    // On the 5th of December, the next one is recorded, and the day after the sweep does not record it twice.
    jest.setSystemTime(Date.UTC(2026, 11, 5, 9, 0, 0));
    await sweepRecurringExpenses(app);
    await sweepRecurringExpenses(app);
    expect(await expenses(ann.token, group)).toHaveLength(4);
    expect((await read(ann.token, id)).body).toMatchObject({ next: '2027-01-05' });
    jest.setSystemTime(T0);
  });

  it('ends, and records nothing more, when a member of its split has left the group', async () => {
    const ann = await signedIn('recurring-leave-ann@example.com', 'Ann');
    const cy = await signedIn('recurring-leave-cy@example.com', 'Cy');
    const group = await createGroup(ann.token, 'Leaving');
    await join(ann.token, group, cy.token);

    const set = await setUp(ann.token, group, {
      description: 'Gym',
      amount: 4000,
      startsOn: '2026-11-05',
      splitBetween: [ann.id, cy.id],
    });
    const id = set.result as string;

    // Cy leaves the group before the day comes: the sweep ends the recurring expense, with no expense for November.
    const left = await http.request('POST', `${api}/groups/${group}/leave`, { token: cy.token });
    await outcome((left.body as { operationId: string }).operationId, cy.token);
    await sweepRecurringExpenses(app);

    expect(await expenses(ann.token, group)).toEqual([]);
    expect((await read(ann.token, id)).status).toBe(404);
    expect((await http.get(`${api}/groups/${group}/recurring`, { token: ann.token })).body).toEqual([]);
  });

  it('is stopped by its payer or the owner, not by another member; what it recorded stays', async () => {
    const ann = await signedIn('recurring-stop-ann@example.com', 'Ann');
    const ben = await signedIn('recurring-stop-ben@example.com', 'Ben');
    const cy = await signedIn('recurring-stop-cy@example.com', 'Cy');
    const group = await createGroup(ann.token, 'Stopping');
    await join(ann.token, group, ben.token);
    await join(ann.token, group, cy.token);

    // Ben pays it, and Ann is the owner: Cy, a member who is neither, cannot stop it.
    const set = await setUp(ann.token, group, {
      description: 'Water',
      amount: 1500,
      startsOn: '2026-10-05',
      splitBetween: [ann.id, ben.id, cy.id],
    });
    // Ann is its payer here, so Ben pays a second one that Cy cannot stop either.
    const benSet = await setUp(ben.token, group, {
      description: 'Power',
      amount: 6000,
      startsOn: '2026-10-05',
      splitBetween: [ann.id, ben.id, cy.id],
    });
    const id = set.result as string;
    const benId = benSet.result as string;

    await sweepRecurringExpenses(app);
    expect(await expenses(ann.token, group)).toHaveLength(4);

    const refused = await http.request('DELETE', `${api}/recurring/${benId}`, { token: cy.token });
    expect(await outcome((refused.body as { operationId: string }).operationId, cy.token)).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotThePayerOrTheOwnerOfRecurring' },
    });

    // Ben, who pays the power, stops it; Ann, the owner, stops the water.
    const stoppedByPayer = await http.request('DELETE', `${api}/recurring/${benId}`, { token: ben.token });
    expect(await outcome((stoppedByPayer.body as { operationId: string }).operationId, ben.token)).toMatchObject({
      status: 'SUCCESS',
    });
    const stoppedByOwner = await http.request('DELETE', `${api}/recurring/${id}`, { token: ann.token });
    expect(await outcome((stoppedByOwner.body as { operationId: string }).operationId, ann.token)).toMatchObject({
      status: 'SUCCESS',
    });

    expect((await read(ann.token, id)).status).toBe(404);
    expect((await read(ann.token, benId)).status).toBe(404);
    expect((await http.get(`${api}/groups/${group}/recurring`, { token: ann.token })).body).toEqual([]);
    // The expenses it recorded stay, and no day is recorded from now on.
    jest.setSystemTime(Date.UTC(2026, 11, 5, 9, 0, 0));
    await sweepRecurringExpenses(app);
    expect(await expenses(ann.token, group)).toHaveLength(4);
    jest.setSystemTime(T0);
  });

  it("lists the group's recurring expenses, the earliest set up first, to members only", async () => {
    const ann = await signedIn('recurring-list-ann@example.com', 'Ann');
    const stranger = await signedIn('recurring-list-stranger@example.com', 'Stranger');
    const group = await createGroup(ann.token, 'Ordering');

    const first = await setUp(ann.token, group, {
      description: 'First',
      amount: 100,
      startsOn: '2026-11-05',
      splitBetween: [ann.id],
    });
    const second = await setUp(ann.token, group, {
      description: 'Second',
      amount: 200,
      startsOn: '2026-11-06',
      splitBetween: [ann.id],
    });
    const listed = (await http.get(`${api}/groups/${group}/recurring`, { token: ann.token })).body as Recurring[];
    expect(listed.map(each => each.id)).toEqual([first.result, second.result]);

    expect((await http.get(`${api}/groups/${group}/recurring`, { token: stranger.token })).status).toBe(404);
    expect((await read(stranger.token, first.result as string)).status).toBe(404);
  });
});

describe('Groups → Ledger', () => {
  it('sets a recurring expense up in a group made in Groups, and finds it and its expense by the id Groups answered', async () => {
    const ann = await signedIn('recurring-rel-ann@example.com', 'Ann');
    const ben = await signedIn('recurring-rel-ben@example.com', 'Ben');
    // Groups makes the group and answers its id; a join is a fact Ledger reads at the moment it decides.
    const groupId = await createGroup(ann.token, 'Just joined');
    await join(ann.token, groupId, ben.token);

    const set = await setUp(ann.token, groupId, {
      description: 'Rent',
      amount: 1001,
      startsOn: '2026-11-05',
      splitBetween: [ann.id, ben.id],
    });
    expect(set).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });
    const listed = (await http.get(`${api}/groups/${groupId}/recurring`, { token: ben.token })).body as Recurring[];
    expect(listed).toEqual([expect.objectContaining({ id: set.result, groupId, paidBy: ann.id })]);

    // The day comes: the sweep reads the group's currency through Groups, and the expense is found by the group's id.
    await sweepRecurringExpenses(app);
    expect(await expenses(ben.token, groupId)).toEqual([
      expect.objectContaining({ groupId, description: 'Rent', amount: 1001, paidBy: ann.id, date: '2026-11-05' }),
    ]);
  });
});
