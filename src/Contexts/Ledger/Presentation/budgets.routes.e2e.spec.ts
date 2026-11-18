import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Categories and budgets, over HTTP (request 24): an expense's category, the owner's monthly budget per category, what the current
 * month spends, and the notice every member receives, once a month, when a month passes a budget. Every answer is held to the API `api/`
 * gives, through `apiClient()`. The notices arrive without anyone acting: the tests poll for them, never wait a fixed time.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-budgets-')), 'tally.sqlite');
  process.env.JOBS_INTERVAL_SECONDS = '0.1';
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

type Person = { token: string; id: string };

let accountCount = 0;
async function signedInPerson(name: string): Promise<Person> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  return { token, id: (created.body as { id: string }).id };
}

/** A group of three, owned by Ada, whom Grace and Linus joined. */
async function groupOfThree() {
  const ada = await signedInPerson('Ada');
  const grace = await signedInPerson('Grace');
  const linus = await signedInPerson('Linus');
  const { id: groupId } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
  ).body as { id: string };
  for (const person of [grace, linus]) {
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return { ada, grace, linus, groupId };
}

const setBudget = (groupId: string, category: string, body: unknown, token?: string) =>
  http.request('PUT', `${api}/groups/${groupId}/budgets/${category}`, { body, token });
const removeBudget = (groupId: string, category: string, token?: string) =>
  http.request('DELETE', `${api}/groups/${groupId}/budgets/${category}`, { token });
const budgetsOf = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/budgets`, { token });
const record = (groupId: string, body: Record<string, unknown>, token: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });

/** Today and a day of the previous month, as the server says today: the `Date` header every answer carries (ARCH-E2E). */
async function days(): Promise<{ today: string; thisMonth: string; lastMonth: string; lastMonthDay: string }> {
  const now = new Date(String((await http.request('GET', `${api}/accounts/me`)).headers.get('date')));
  const today = now.toISOString().slice(0, 10);
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  return {
    today,
    thisMonth: today.slice(0, 7),
    lastMonth: previous.toISOString().slice(0, 7),
    lastMonthDay: previous.toISOString().slice(0, 10),
  };
}

type BudgetNotice = {
  id: string;
  kind: string;
  groupId: string;
  category: string;
  month: string;
  budget: number;
  amount: number;
  at: string;
};

/** A person's budget notices, polled until `count` have arrived (or about three seconds have passed); asked for none, once more after a wait. */
async function budgetNoticesOf(person: Person, count: number): Promise<BudgetNotice[]> {
  let found: BudgetNotice[] = [];
  for (let poll = 0; poll < 120; poll++) {
    const answer = await http.request('GET', `${api}/notices`, { token: person.token });
    expect(answer.status).toBe(200);
    found = (answer.body as BudgetNotice[]).filter(notice => notice.kind === 'budget');
    if (found.length >= count && (count > 0 || poll > 5)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return found;
}

describe('the category of an expense', () => {
  it('is given when it is recorded or edited, and is other when it is not given', async () => {
    const { ada, grace, groupId } = await groupOfThree();
    const date = (await days()).today;
    const given = await record(
      groupId,
      { description: 'Market', amount: 500, date, category: 'groceries', splitBetween: [ada.id, grace.id] },
      ada.token,
    );
    const left = await record(
      groupId,
      { description: 'Misc', amount: 100, date, splitBetween: [ada.id, grace.id] },
      ada.token,
    );
    expect(given.status).toBe(201);
    const read = async (id: string) =>
      (await http.request('GET', `${api}/expenses/${id}`, { token: grace.token })).body as {
        category: string;
        version: number;
      };
    expect((await read((given.body as { id: string }).id)).category).toBe('groceries');
    expect((await read((left.body as { id: string }).id)).category).toBe('other');

    const edit = (id: string, body: Record<string, unknown>, version: number) =>
      http.request('PUT', `${api}/expenses/${id}`, {
        body: { description: 'Market', amount: 500, date, splitBetween: [ada.id, grace.id], version, ...body },
        token: ada.token,
      });
    const givenId = (given.body as { id: string }).id;
    expect((await edit(givenId, { category: 'food' }, 1)).status).toBe(204);
    expect((await read(givenId)).category).toBe('food');
    // An edit gives the expense again, whole: with no category it is other.
    expect((await edit(givenId, {}, 2)).status).toBe(204);
    expect((await read(givenId)).category).toBe('other');
    const listed = (await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: ada.token })).body as {
      category: string;
    }[];
    expect(listed.map(expense => expense.category)).toEqual(['other', 'other']);
  });

  it('refuses a category that is not one of the eight, and a body whose category is not a string', async () => {
    const { ada, grace, groupId } = await groupOfThree();
    const body = { description: 'Market', amount: 500, date: (await days()).today, splitBetween: [ada.id, grace.id] };
    const unknown = await record(groupId, { ...body, category: 'pets' }, ada.token);
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ type: 'InvalidExpenseCategory', message: expect.any(String) });
    expect((await record(groupId, { ...body, category: 7 }, ada.token)).status).toBe(400);
  });

  it('is kept by a recurring expense, for the expenses it records', async () => {
    const { ada, grace, groupId } = await groupOfThree();
    const now = new Date(String((await http.request('GET', `${api}/accounts/me`)).headers.get('date')));
    const startsOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 5)).toISOString().slice(0, 10);
    const recurring = await http.request('POST', `${api}/groups/${groupId}/recurring`, {
      body: { description: 'Rent', amount: 900, startsOn, category: 'rent', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });
    expect(recurring.status).toBe(201);
    const { id } = recurring.body as { id: string };
    const read = await http.request('GET', `${api}/recurring/${id}`, { token: grace.token });
    expect(read.body).toMatchObject({ id, category: 'rent' });
    const plain = await http.request('POST', `${api}/groups/${groupId}/recurring`, {
      body: { description: 'Gym', amount: 900, startsOn, splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });
    expect(
      (await http.request('GET', `${api}/recurring/${(plain.body as { id: string }).id}`, { token: ada.token })).body,
    ).toMatchObject({ category: 'other' });
    const refused = await http.request('POST', `${api}/groups/${groupId}/recurring`, {
      body: { description: 'Gym', amount: 900, startsOn, category: 'pets', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });
    expect(refused.status).toBe(400);

    let rents: { category: string }[] = [];
    for (let poll = 0; poll < 100 && rents.length === 0; poll++) {
      const listed = (await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: ada.token })).body as {
        description: string;
        category: string;
      }[];
      rents = listed.filter(expense => expense.description === 'Rent');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(rents.map(expense => expense.category)).toEqual(['rent', ...rents.slice(1).map(() => 'rent')]);
  });
});

describe('the budgets of a group', () => {
  it('are set and replaced by the owner, and read in the order of the categories with what the month spends', async () => {
    const { ada, grace, groupId } = await groupOfThree();
    const { today, lastMonthDay } = await days();
    expect((await budgetsOf(groupId, ada.token)).body).toEqual([]);

    expect((await setBudget(groupId, 'travel', { amount: 900 }, ada.token)).status).toBe(204);
    expect((await setBudget(groupId, 'groceries', { amount: 40000 }, ada.token)).status).toBe(204);
    expect((await setBudget(groupId, 'groceries', { amount: 45000 }, ada.token)).status).toBe(204);

    const split = [ada.id, grace.id];
    await record(
      groupId,
      { description: 'Market', amount: 1200, date: today, category: 'groceries', splitBetween: split },
      grace.token,
    );
    await record(
      groupId,
      { description: 'Market', amount: 300, date: today, category: 'groceries', splitBetween: split },
      ada.token,
    );
    await record(
      groupId,
      { description: 'Last month', amount: 700, date: lastMonthDay, category: 'groceries', splitBetween: split },
      ada.token,
    );
    await record(
      groupId,
      { description: 'Cinema', amount: 800, date: today, category: 'leisure', splitBetween: split },
      ada.token,
    );
    const deleted = await record(
      groupId,
      { description: 'Taxi', amount: 50, date: today, category: 'travel', splitBetween: split },
      ada.token,
    );
    expect(
      (await http.request('DELETE', `${api}/expenses/${(deleted.body as { id: string }).id}`, { token: ada.token }))
        .status,
    ).toBe(204);

    const read = await budgetsOf(groupId, grace.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([
      { category: 'groceries', amount: 45000, spent: 1500 },
      { category: 'travel', amount: 900, spent: 0 },
    ]);
  });

  it('are removed by the owner, and a category without one has nothing to remove', async () => {
    const { ada, groupId } = await groupOfThree();
    await setBudget(groupId, 'rent', { amount: 100 }, ada.token);
    expect((await removeBudget(groupId, 'rent', ada.token)).status).toBe(204);
    expect((await budgetsOf(groupId, ada.token)).body).toEqual([]);
    expect((await removeBudget(groupId, 'rent', ada.token)).status).toBe(404);
    expect((await removeBudget(groupId, 'utilities', ada.token)).status).toBe(404);
  });

  it('are refused to any other member, and not found by anyone who is not one, nor by nobody', async () => {
    const { ada, grace, groupId } = await groupOfThree();
    const stranger = await signedInPerson('Stranger');
    await setBudget(groupId, 'rent', { amount: 100 }, ada.token);

    const refused = await setBudget(groupId, 'rent', { amount: 1 }, grace.token);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ type: 'NotAllowed', message: expect.any(String) });
    expect((await removeBudget(groupId, 'rent', grace.token)).status).toBe(403);
    expect((await setBudget(groupId, 'rent', { amount: 100 }, stranger.token)).status).toBe(404);
    expect((await removeBudget(groupId, 'rent', stranger.token)).status).toBe(404);
    expect((await budgetsOf(groupId, stranger.token)).status).toBe(404);
    expect((await setBudget(groupId, 'rent', { amount: 100 })).status).toBe(401);
    expect((await removeBudget(groupId, 'rent')).status).toBe(401);
    expect((await budgetsOf(groupId)).status).toBe(401);
    expect((await budgetsOf(groupId, grace.token)).body).toEqual([{ category: 'rent', amount: 100, spent: 0 }]);
  });

  it('refuse an amount that is not from 1 to 100 000 000 and a category that is not one of the eight; a body of another shape is refused at once', async () => {
    const { ada, groupId } = await groupOfThree();
    for (const amount of [0, -5, 100_000_001]) {
      const answer = await setBudget(groupId, 'rent', { amount }, ada.token);
      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ type: 'InvalidBudgetAmount', message: expect.any(String) });
    }
    expect((await setBudget(groupId, 'rent', { amount: 100_000_000 }, ada.token)).status).toBe(204);
    expect((await setBudget(groupId, 'rent', { amount: 1 }, ada.token)).status).toBe(204);
    const unknown = await setBudget(groupId, 'pets', { amount: 100 }, ada.token);
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ type: 'InvalidExpenseCategory', message: expect.any(String) });
    expect((await removeBudget(groupId, 'pets', ada.token)).status).toBe(400);
    expect((await setBudget(groupId, 'rent', {}, ada.token)).status).toBe(400);
    expect((await setBudget(groupId, 'rent', { amount: '100' }, ada.token)).status).toBe(400);
    expect((await setBudget(groupId, 'rent', { amount: 1.5 }, ada.token)).status).toBe(400);
  });
});

describe('passing a budget', () => {
  it('tells every member once when a month’s spending in a category passes its budget', async () => {
    const { ada, grace, linus, groupId } = await groupOfThree();
    const { today, thisMonth, lastMonth, lastMonthDay } = await days();
    const split = [ada.id, grace.id, linus.id];
    // Setting a budget makes no notice by itself, even when the month is already over it.
    await record(
      groupId,
      { description: 'Before', amount: 500, date: today, category: 'groceries', splitBetween: split },
      grace.token,
    );
    expect((await setBudget(groupId, 'groceries', { amount: 400 }, ada.token)).status).toBe(204);
    expect(await budgetNoticesOf(ada, 0)).toEqual([]);

    // Within the budget in another category, and exactly at a budget, passes nothing; so does an expense of no budget's category.
    await setBudget(groupId, 'leisure', { amount: 300 }, ada.token);
    await record(
      groupId,
      { description: 'Cinema', amount: 300, date: today, category: 'leisure', splitBetween: split },
      ada.token,
    );
    await record(
      groupId,
      { description: 'Trip', amount: 9000, date: today, category: 'travel', splitBetween: split },
      ada.token,
    );
    expect(await budgetNoticesOf(ada, 0)).toEqual([]);

    // An expense that leaves the month over the budget: every member is told, the payer too.
    const recorded = await record(
      groupId,
      { description: 'Market', amount: 60, date: today, category: 'groceries', splitBetween: split },
      grace.token,
    );
    expect(recorded.status).toBe(201);
    for (const person of [ada, grace, linus]) {
      expect(await budgetNoticesOf(person, 1)).toEqual([
        {
          id: expect.any(String),
          kind: 'budget',
          groupId,
          category: 'groceries',
          month: thisMonth,
          budget: 400,
          amount: 560,
          at: expect.stringMatching(/Z$/),
        },
      ]);
    }

    // The month goes further over: nothing more. It comes back under (an edit) and over again: nothing more.
    const further = (
      await record(
        groupId,
        { description: 'More', amount: 100, date: today, category: 'groceries', splitBetween: split },
        ada.token,
      )
    ).body as { id: string };
    const under = await http.request('PUT', `${api}/expenses/${further.id}`, {
      body: { description: 'More', amount: 100, date: today, category: 'food', splitBetween: split, version: 1 },
      token: ada.token,
    });
    expect(under.status).toBe(204);
    const over = await http.request('PUT', `${api}/expenses/${further.id}`, {
      body: { description: 'More', amount: 100, date: today, category: 'groceries', splitBetween: split, version: 2 },
      token: ada.token,
    });
    expect(over.status).toBe(204);
    // A budget removed and set again does not make the month's notice again either.
    await removeBudget(groupId, 'groceries', ada.token);
    await setBudget(groupId, 'groceries', { amount: 400 }, ada.token);
    await record(
      groupId,
      { description: 'Again', amount: 10, date: today, category: 'groceries', splitBetween: split },
      ada.token,
    );
    expect(await budgetNoticesOf(linus, 1)).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 400));
    for (const person of [ada, grace, linus]) expect(await budgetNoticesOf(person, 1)).toHaveLength(1);

    // Another month of the same category is another notice, for that month.
    await record(
      groupId,
      { description: 'Old', amount: 450, date: lastMonthDay, category: 'groceries', splitBetween: split },
      ada.token,
    );
    const notices = await budgetNoticesOf(grace, 2);
    expect(notices.map(notice => [notice.month, notice.amount])).toEqual([
      [lastMonth, 450],
      [thisMonth, 560],
    ]);
  });

  it('is decided when an expense is edited too, and by a change of its date into a month over the budget', async () => {
    const { ada, grace, groupId } = await groupOfThree();
    const { today, thisMonth, lastMonthDay } = await days();
    const split = [ada.id, grace.id];
    await setBudget(groupId, 'leisure', { amount: 150 }, ada.token);
    const small = (
      await record(
        groupId,
        { description: 'Bowling', amount: 100, date: lastMonthDay, category: 'leisure', splitBetween: split },
        grace.token,
      )
    ).body as { id: string };
    await record(
      groupId,
      { description: 'Concert', amount: 100, date: today, category: 'leisure', splitBetween: split },
      grace.token,
    );
    expect(await budgetNoticesOf(ada, 0)).toEqual([]);

    // Moving the first expense into this month makes it spend 200, over 150.
    const edited = await http.request('PUT', `${api}/expenses/${small.id}`, {
      body: { description: 'Bowling', amount: 100, date: today, category: 'leisure', splitBetween: split, version: 1 },
      token: ada.token,
    });
    expect(edited.status).toBe(204);
    expect(await budgetNoticesOf(ada, 1)).toEqual([
      expect.objectContaining({ category: 'leisure', month: thisMonth, budget: 150, amount: 200 }),
    ]);
    expect(await budgetNoticesOf(grace, 1)).toHaveLength(1);
  });
});
