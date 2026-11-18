import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The budgets of request 24, over HTTP: an expense's category, the owner's monthly budget per category, the read of the budgets with what the
 * current month spends, and the notice each member gets once when a month passes a budget. Expenses are dated today (UTC, as the server answers),
 * so that they fall in the current month.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
/** Today and its month, as the server answers them: read from the `Date` of its answers, so that these tests read no clock of their own. */
let today: string;
let month: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-budgets-'));
  app = await createApplication({ databaseUrl: await freshDatabase(), logger: silent });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const serverToday = new Date((await http.request('GET', `${api}/accounts/me`)).headers.get('date') ?? '');
  today = serverToday.toISOString().slice(0, 10);
  month = today.slice(0, 7);
});
afterAll(async () => {
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

interface Person {
  token: string;
  id: string;
}

async function person(name: string, email: string): Promise<Person> {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group of `owner`, with `others` joined. */
async function groupOf(owner: Person, others: Person[]): Promise<string> {
  const { body } = await http.request('POST', `${api}/groups`, {
    token: owner.token,
    body: { name: 'Budget', currency: 'EUR' },
  });
  const groupId = (body as { id: string }).id;
  for (const who of others) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: who.token,
    });
  }
  return groupId;
}

/** An expense of today, paid by `payer` and split between `between` (the payer among them), with the given extra body. */
function recordToday(payer: Person, groupId: string, between: Person[], extra: Record<string, unknown>) {
  return http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: payer.token,
    body: { description: 'Shop', date: today, splitBetween: between.map(who => who.id), ...extra },
  });
}

async function budgetNoticesOf(who: Person): Promise<Array<Record<string, unknown>>> {
  const { body } = await http.request('GET', `${api}/notices`, { token: who.token });
  return (body as Array<Record<string, unknown>>).filter(notice => notice.kind === 'budget');
}

/** Waits (a few seconds at most) until `who` has `count` budget notices, and answers them. */
async function waitForBudgetNotices(who: Person, count: number): Promise<Array<Record<string, unknown>>> {
  let notices: Array<Record<string, unknown>> = [];
  for (let poll = 0; poll < 120; poll++) {
    notices = await budgetNoticesOf(who);
    if (notices.length >= count) break;
    await sleep(25);
  }
  return notices;
}

describe('a budget is set and removed by the owner', () => {
  it('the owner sets a budget and sets it again to replace it; a member is refused with 403, a stranger finds no group (404), and a bad category or amount is 422', async () => {
    const ann = await person('Ann', 'ann@budgets.example.com');
    const bob = await person('Bob', 'bob@budgets.example.com');
    const eve = await person('Eve', 'eve@budgets.example.com');
    const groupId = await groupOf(ann, [bob]);

    const set = (who: Person, category: string, amount: unknown) =>
      http.request('PUT', `${api}/groups/${groupId}/budgets/${category}`, { token: who.token, body: { amount } });

    expect((await set(ann, 'groceries', 1000)).status).toBe(204);
    expect((await set(ann, 'groceries', 1500)).status).toBe(204);

    const byMember = await set(bob, 'groceries', 1000);
    expect(byMember.status).toBe(403);
    expect(byMember.body).toEqual({ type: 'NotAllowed', message: expect.any(String) });
    expect((await set(eve, 'groceries', 1000)).status).toBe(404);

    const badCategory = await set(ann, 'cars', 1000);
    expect(badCategory.status).toBe(422);
    expect(badCategory.body).toEqual({ type: 'InvalidExpenseCategory', message: expect.any(String) });
    const badAmount = await set(ann, 'food', 0);
    expect(badAmount.status).toBe(422);
    expect(badAmount.body).toEqual({ type: 'InvalidBudgetAmount', message: expect.any(String) });
    expect((await set(ann, 'food', 'lots')).status).toBe(400);
  });

  it('the owner removes a budget; a member is refused with 403, and a category with no budget is 404', async () => {
    const ann = await person('Ann', 'ann@remove.budgets.example.com');
    const bob = await person('Bob', 'bob@remove.budgets.example.com');
    const groupId = await groupOf(ann, [bob]);
    await http.request('PUT', `${api}/groups/${groupId}/budgets/rent`, { token: ann.token, body: { amount: 90000 } });

    expect((await http.request('DELETE', `${api}/groups/${groupId}/budgets/rent`, { token: bob.token })).status).toBe(
      403,
    );
    expect((await http.request('DELETE', `${api}/groups/${groupId}/budgets/rent`, { token: ann.token })).status).toBe(
      204,
    );
    const again = await http.request('DELETE', `${api}/groups/${groupId}/budgets/rent`, { token: ann.token });
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ type: 'NotFound', message: expect.any(String) });
  });
});

describe('a member reads the budgets', () => {
  it('lists each category that has a budget, in the order of the categories, with what the current month spends in it', async () => {
    const ann = await person('Ann', 'ann@read.budgets.example.com');
    const bob = await person('Bob', 'bob@read.budgets.example.com');
    const stranger = await person('Sam', 'sam@read.budgets.example.com');
    const groupId = await groupOf(ann, [bob]);
    await http.request('PUT', `${api}/groups/${groupId}/budgets/rent`, { token: ann.token, body: { amount: 90000 } });
    await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
      token: ann.token,
      body: { amount: 1000 },
    });
    await recordToday(ann, groupId, [ann, bob], { amount: 300, category: 'groceries' });
    await recordToday(bob, groupId, [ann, bob], { amount: 100, category: 'groceries' });

    const read = await http.request('GET', `${api}/groups/${groupId}/budgets`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual([
      { category: 'groceries', amount: 1000, spent: 400 },
      { category: 'rent', amount: 90000, spent: 0 },
    ]);
    expect((await http.request('GET', `${api}/groups/${groupId}/budgets`, { token: stranger.token })).status).toBe(404);
  });
});

describe('an expense has a category', () => {
  it('is other when none is given, keeps the one it is given when recorded and edited, and is refused when it is not one of the eight', async () => {
    const ann = await person('Ann', 'ann@category.budgets.example.com');
    const groupId = await groupOf(ann, []);

    const plain = await recordToday(ann, groupId, [ann], { amount: 500 });
    const plainId = (plain.body as { id: string }).id;
    expect((await http.request('GET', `${api}/expenses/${plainId}`, { token: ann.token })).body).toMatchObject({
      category: 'other',
    });

    const food = await recordToday(ann, groupId, [ann], { amount: 700, category: 'food' });
    const foodId = (food.body as { id: string }).id;
    expect((await http.request('GET', `${api}/expenses/${foodId}`, { token: ann.token })).body).toMatchObject({
      category: 'food',
    });

    const refused = await recordToday(ann, groupId, [ann], { amount: 700, category: 'cars' });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'InvalidExpenseCategory', message: expect.any(String) });

    const edited = await http.request('PUT', `${api}/expenses/${foodId}`, {
      token: ann.token,
      body: { description: 'Shop', date: today, amount: 700, splitBetween: [ann.id], version: 1, category: 'rent' },
    });
    expect(edited.status).toBe(204);
    expect((await http.request('GET', `${api}/expenses/${foodId}`, { token: ann.token })).body).toMatchObject({
      category: 'rent',
      version: 2,
    });
  });

  it('a recurring expense keeps the category it is set up with, and the expenses it records have it', async () => {
    const ann = await person('Ann', 'ann@recurring.budgets.example.com');
    const groupId = await groupOf(ann, []);
    const set = await http.request('POST', `${api}/groups/${groupId}/recurring`, {
      token: ann.token,
      body: {
        description: 'Internet',
        amount: 3000,
        startsOn: `${month}-01`,
        splitBetween: [ann.id],
        category: 'utilities',
      },
    });
    const recurringId = (set.body as { id: string }).id;

    expect((await http.request('GET', `${api}/recurring/${recurringId}`, { token: ann.token })).body).toMatchObject({
      category: 'utilities',
    });
    await http.request('DELETE', `${api}/recurring/${recurringId}`, { token: ann.token });
  });
});

describe('a month that passes its budget is told to every member, once', () => {
  it('when an expense makes its month spend more than the budget, every member gets a notice; a month that goes further over, or comes back under and over again, makes no other', async () => {
    const ann = await person('Ann', 'ann@notice.budgets.example.com');
    const bob = await person('Bob', 'bob@notice.budgets.example.com');
    const groupId = await groupOf(ann, [bob]);
    await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
      token: ann.token,
      body: { amount: 1000 },
    });

    await recordToday(ann, groupId, [ann, bob], { amount: 600, category: 'groceries' });
    expect(await budgetNoticesOf(bob)).toEqual([]);

    // 1200 spent in the month, over the 1000 budget: each member is told once.
    await recordToday(ann, groupId, [ann, bob], { amount: 600, category: 'groceries' });
    const annsNotices = await waitForBudgetNotices(ann, 1);
    const bobsNotices = await waitForBudgetNotices(bob, 1);
    const expected = {
      id: expect.any(String),
      kind: 'budget',
      groupId,
      category: 'groceries',
      month,
      budget: 1000,
      amount: 1200,
      at: expect.any(String),
    };
    expect(annsNotices).toEqual([expected]);
    expect(bobsNotices).toEqual([expected]);

    // Further over in the same month: no other notice. Removing the budget and setting it again changes nothing either.
    await recordToday(bob, groupId, [ann, bob], { amount: 500, category: 'groceries' });
    await http.request('DELETE', `${api}/groups/${groupId}/budgets/groceries`, { token: ann.token });
    await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
      token: ann.token,
      body: { amount: 1000 },
    });
    await recordToday(ann, groupId, [ann, bob], { amount: 100, category: 'groceries' });
    await sleep(300);
    expect(await budgetNoticesOf(ann)).toHaveLength(1);
    expect(await budgetNoticesOf(bob)).toHaveLength(1);
  });
});
