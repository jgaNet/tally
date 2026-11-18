import { jest } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

/** The instant the test starts at, the 18th of November 2026: the system clock reads the faked Date, so the current month is November. */
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
type Notice = {
  id: string;
  kind: string;
  groupId: string;
  category?: string;
  month?: string;
  budget?: number;
  amount: number;
};

/** Today and this month in UTC, which the budgets' current month is read at. */
const TODAY = '2026-11-18';
const MONTH = '2026-11';
/** A day of a month long past, which is never the current month. */
const OLD_DAY = '2025-01-15';

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

/** A flat of two, Ann its owner and Ben a member. */
async function flat(suffix: string) {
  const ann = await signedIn(`budget-ann-${suffix}@example.com`, 'Ann');
  const ben = await signedIn(`budget-ben-${suffix}@example.com`, 'Ben');
  const group = await createGroup(ann.token, 'Flat');
  await join(ann.token, group, ben.token);
  return { ann, ben, group };
}

async function command(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  token: string,
  body?: object,
): Promise<Operation> {
  const answer = await http.request(method, `${api}${path}`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

const setBudget = (token: string, group: string, category: string, amount: number) =>
  command('PUT', `/groups/${group}/budgets/${category}`, token, { amount });
const removeBudget = (token: string, group: string, category: string) =>
  command('DELETE', `/groups/${group}/budgets/${category}`, token);
const record = (token: string, group: string, who: string[], body: object) =>
  command('POST', `/groups/${group}/expenses`, token, {
    description: 'Shopping',
    date: TODAY,
    splitBetween: who,
    ...body,
  });

async function budgets(token: string, group: string) {
  return http.get(`${api}/groups/${group}/budgets`, { token });
}

async function notices(token: string): Promise<Notice[]> {
  const { body } = await http.get(`${api}/notices`, { token });
  return body as Notice[];
}

/** The budget notices a person has for a group, waiting until `count` of them are there (or a while, when none is expected). */
async function budgetNotices(token: string, group: string, count: number): Promise<Notice[]> {
  let found: Notice[] = [];
  for (let attempt = 0; attempt < (count ? 250 : 40); attempt++) {
    found = (await notices(token)).filter(notice => notice.kind === 'budget' && notice.groupId === group);
    if (found.length >= count && count) return found;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return found;
}

describe('the category of an expense (request 24)', () => {
  it('is given when an expense is recorded or edited, and is other when it is not given', async () => {
    const { ann, ben, group } = await flat('category');

    const plain = await record(ann.token, group, [ann.id, ben.id], { amount: 100 });
    const read = await http.get(`${api}/expenses/${plain.result}`, { token: ben.token });
    expect(read.body).toMatchObject({ id: plain.result, category: 'other', version: 1 });

    const given = await record(ann.token, group, [ann.id, ben.id], { amount: 100, category: 'groceries' });
    expect((await http.get(`${api}/expenses/${given.result}`, { token: ann.token })).body).toMatchObject({
      category: 'groceries',
    });

    const edited = await command('PUT', `/expenses/${given.result}`, ann.token, {
      description: 'Shopping',
      date: TODAY,
      amount: 100,
      splitBetween: [ann.id, ben.id],
      version: 1,
      category: 'travel',
    });
    expect(edited.status).toBe('SUCCESS');
    expect((await http.get(`${api}/expenses/${given.result}`, { token: ann.token })).body).toMatchObject({
      category: 'travel',
      version: 2,
    });
  });

  it('refuses a word that is not one of the eight, behind the 202, and a category of the wrong type with 400', async () => {
    const { ann, group } = await flat('invalid-category');

    const refused = await record(ann.token, group, [ann.id], { amount: 100, category: 'pets' });
    expect(refused).toMatchObject({ status: 'ERROR', error: { type: 'InvalidCategory', message: expect.any(String) } });

    const wrongShape = await http.request('POST', `${api}/groups/${group}/expenses`, {
      token: ann.token,
      body: { description: 'Shopping', date: TODAY, amount: 100, splitBetween: [ann.id], category: 5 },
    });
    expect(wrongShape.status).toBe(400);
  });

  it('is kept by a recurring expense, which gives it to its expenses', async () => {
    const { ann, group } = await flat('recurring-category');

    const set = await command('POST', `/groups/${group}/recurring`, ann.token, {
      description: 'Rent',
      amount: 50000,
      startsOn: '2027-01-05',
      splitBetween: [ann.id],
      category: 'rent',
    });
    expect(set.status).toBe('SUCCESS');
    expect((await http.get(`${api}/recurring/${set.result}`, { token: ann.token })).body).toMatchObject({
      id: set.result,
      category: 'rent',
    });

    const other = await command('POST', `/groups/${group}/recurring`, ann.token, {
      description: 'Phone',
      amount: 2000,
      startsOn: '2027-01-05',
      splitBetween: [ann.id],
    });
    expect((await http.get(`${api}/recurring/${other.result}`, { token: ann.token })).body).toMatchObject({
      category: 'other',
    });
  });
});

describe('a group’s budgets (request 24)', () => {
  it('are set by the owner, replaced when set again, read in the order of the categories with what this month spends, and removed', async () => {
    const { ann, ben, group } = await flat('set');
    expect((await budgets(ben.token, group)).body).toEqual([]);

    expect(await setBudget(ann.token, group, 'travel', 90000)).toMatchObject({ status: 'SUCCESS' });
    expect(await setBudget(ann.token, group, 'groceries', 40000)).toMatchObject({ status: 'SUCCESS' });
    await record(ann.token, group, [ann.id, ben.id], { amount: 1500, category: 'groceries' });
    await record(ann.token, group, [ann.id, ben.id], { amount: 700, category: 'groceries' });
    await record(ann.token, group, [ann.id, ben.id], { amount: 900, category: 'travel', date: OLD_DAY });
    await record(ann.token, group, [ann.id, ben.id], { amount: 300, category: 'leisure' });

    expect(await budgets(ben.token, group)).toMatchObject({
      status: 200,
      body: [
        { category: 'groceries', amount: 40000, spent: 2200 },
        { category: 'travel', amount: 90000, spent: 0 },
      ],
    });

    // Setting it again replaces it.
    await setBudget(ann.token, group, 'groceries', 5000);
    expect((await budgets(ann.token, group)).body).toEqual([
      { category: 'groceries', amount: 5000, spent: 2200 },
      { category: 'travel', amount: 90000, spent: 0 },
    ]);

    expect(await removeBudget(ann.token, group, 'groceries')).toMatchObject({ status: 'SUCCESS' });
    expect((await budgets(ann.token, group)).body).toEqual([{ category: 'travel', amount: 90000, spent: 0 }]);
  });

  it('leave out a deleted expense, and count an expense edited into the category', async () => {
    const { ann, ben, group } = await flat('spent');
    await setBudget(ann.token, group, 'food', 10000);
    const kept = await record(ann.token, group, [ann.id, ben.id], { amount: 400, category: 'food' });
    const deleted = await record(ann.token, group, [ann.id, ben.id], { amount: 600, category: 'food' });
    const moved = await record(ann.token, group, [ann.id, ben.id], { amount: 50, category: 'leisure' });
    expect(kept.status).toBe('SUCCESS');

    await command('DELETE', `/expenses/${deleted.result}`, ann.token);
    await command('PUT', `/expenses/${moved.result}`, ann.token, {
      description: 'Shopping',
      date: TODAY,
      amount: 50,
      splitBetween: [ann.id, ben.id],
      version: 1,
      category: 'food',
    });

    expect((await budgets(ben.token, group)).body).toEqual([{ category: 'food', amount: 10000, spent: 450 }]);
  });

  it('are refused to a member who is not the owner, and with an amount or a category that is not allowed', async () => {
    const { ann, ben, group } = await flat('refused');

    expect(await setBudget(ben.token, group, 'rent', 10000)).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotTheOwnerOfTheGroup' },
    });
    await setBudget(ann.token, group, 'rent', 10000);
    expect(await removeBudget(ben.token, group, 'rent')).toMatchObject({
      status: 'ERROR',
      error: { type: 'NotTheOwnerOfTheGroup' },
    });
    expect((await budgets(ben.token, group)).body).toEqual([{ category: 'rent', amount: 10000, spent: 0 }]);

    for (const amount of [0, -5, 100_000_001]) {
      expect(await setBudget(ann.token, group, 'rent', amount)).toMatchObject({
        status: 'ERROR',
        error: { type: 'InvalidAmount' },
      });
    }
    expect(await setBudget(ann.token, group, 'rent', 100_000_000)).toMatchObject({ status: 'SUCCESS' });
    expect(await setBudget(ann.token, group, 'pets', 100)).toMatchObject({
      status: 'ERROR',
      error: { type: 'InvalidCategory' },
    });
    expect(await removeBudget(ann.token, group, 'leisure')).toMatchObject({
      status: 'ERROR',
      error: { type: 'BudgetNotSet' },
    });

    const wrongShape = await http.request('PUT', `${api}/groups/${group}/budgets/rent`, {
      token: ann.token,
      body: { amount: 'much' },
    });
    expect(wrongShape.status).toBe(400);
  });

  it('are the group’s members’ to read, and nobody else’s', async () => {
    const { ann, group } = await flat('private');
    const stranger = await signedIn('budget-stranger@example.com', 'Sue');

    expect((await budgets(stranger.token, group)).status).toBe(404);
    expect((await http.get(`${api}/groups/${group}/budgets`)).status).toBe(401);
    expect(await setBudget(stranger.token, group, 'rent', 100)).toMatchObject({ status: 'ERROR' });
    expect((await budgets(ann.token, group)).body).toEqual([]);
  });
});

describe('passing a budget (request 24)', () => {
  it('tells every member, the payer too, once for the group, the category and the month', async () => {
    const { ann, ben, group } = await flat('passed');
    await setBudget(ann.token, group, 'groceries', 1000);
    // Setting a budget makes no notice by itself, even when the month already spends more.
    await record(ann.token, group, [ann.id, ben.id], { amount: 900, category: 'groceries' });
    expect(await budgetNotices(ben.token, group, 0)).toEqual([]);

    // Exactly the budget is not passing it; one more is.
    await record(ann.token, group, [ann.id, ben.id], { amount: 100, category: 'groceries' });
    expect(await budgetNotices(ben.token, group, 0)).toEqual([]);
    await record(ann.token, group, [ann.id, ben.id], { amount: 1, category: 'groceries' });

    for (const member of [ann, ben]) {
      const found = await budgetNotices(member.token, group, 1);
      expect(found).toEqual([
        {
          id: expect.any(String),
          kind: 'budget',
          groupId: group,
          category: 'groceries',
          month: MONTH,
          budget: 1000,
          amount: 1001,
          at: expect.any(String),
        },
      ]);
    }

    // A month that goes further over makes no other, nor one that comes back under and over again.
    const further = await record(ann.token, group, [ann.id, ben.id], { amount: 500, category: 'groceries' });
    await command('DELETE', `/expenses/${further.result}`, ann.token);
    await record(ann.token, group, [ann.id, ben.id], { amount: 5000, category: 'groceries' });
    await setBudget(ann.token, group, 'groceries', 200);
    await record(ann.token, group, [ann.id, ben.id], { amount: 5, category: 'groceries' });
    expect(await budgetNotices(ben.token, group, 2)).toHaveLength(1);
    expect(await budgetNotices(ann.token, group, 2)).toHaveLength(1);

    // Another category, or another month, is another notice.
    await setBudget(ann.token, group, 'leisure', 100);
    await record(ann.token, group, [ann.id, ben.id], { amount: 101, category: 'leisure' });
    expect(await budgetNotices(ben.token, group, 2)).toHaveLength(2);
  });

  it('is decided when an expense is edited into a month that passes its budget', async () => {
    const { ann, ben, group } = await flat('edited');
    await setBudget(ann.token, group, 'transport', 1000);
    const small = await record(ann.token, group, [ann.id, ben.id], { amount: 200, category: 'transport' });
    expect(await budgetNotices(ben.token, group, 0)).toEqual([]);

    const edited = await command('PUT', `/expenses/${small.result}`, ben.token === ann.token ? ben.token : ann.token, {
      description: 'Shopping',
      date: TODAY,
      amount: 1200,
      splitBetween: [ann.id, ben.id],
      version: 1,
      category: 'transport',
    });
    expect(edited.status).toBe('SUCCESS');

    const found = await budgetNotices(ben.token, group, 1);
    expect(found).toMatchObject([{ kind: 'budget', category: 'transport', month: MONTH, budget: 1000, amount: 1200 }]);
    expect(await budgetNotices(ann.token, group, 1)).toHaveLength(1);
  });

  it('is made for the month of the expense, and for none that is removed or has no budget', async () => {
    const { ann, ben, group } = await flat('months');
    await setBudget(ann.token, group, 'rent', 1000);
    await setBudget(ann.token, group, 'travel', 1000);
    await removeBudget(ann.token, group, 'travel');

    await record(ann.token, group, [ann.id, ben.id], { amount: 5000, category: 'travel' });
    await record(ann.token, group, [ann.id, ben.id], { amount: 5000, category: 'other' });
    await record(ann.token, group, [ann.id, ben.id], { amount: 1500, category: 'rent', date: OLD_DAY });

    const found = await budgetNotices(ben.token, group, 1);
    expect(found).toMatchObject([{ category: 'rent', month: OLD_DAY.slice(0, 7), budget: 1000, amount: 1500 }]);
    expect(await budgetNotices(ben.token, group, 2)).toHaveLength(1);
    // What the current month spends is not that month's.
    expect((await budgets(ann.token, group)).body).toEqual([{ category: 'rent', amount: 1000, spent: 0 }]);
  });
});

describe('Groups → Ledger', () => {
  it('finds, by the id Groups answered for the group, the budgets its owner set and its members read', async () => {
    const { ann, ben, group } = await flat('relation');
    expect(await setBudget(ann.token, group, 'utilities', 7000)).toMatchObject({ status: 'SUCCESS' });

    const read = await budgets(ben.token, group);
    expect(read.body).toEqual([{ category: 'utilities', amount: 7000, spent: 0 }]);
    // Who the owner is, Groups decides: Ben, who joined, is not.
    expect(await setBudget(ben.token, group, 'utilities', 1)).toMatchObject({ status: 'ERROR' });
  });
});
