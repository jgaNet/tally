import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';

/** The day `day` of the month `monthsAgo` months before the current one (UTC), as `YYYY-MM-DD`. */
function dayOfMonth(monthsAgo: number, day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day)).toISOString().slice(0, 10);
}

describe('categories', () => {
  let app: Application;

  beforeEach(async () => {
    app = await createApplication({ databaseUrl: await temporaryDatabaseUrl() });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function setup() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    return { ada, grace, groupId };
  }

  async function readExpense(token: string, id: string) {
    const response = await send(app, 'GET', `/expenses/${id}`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ id: string; category: string; version: number }>();
  }

  it('gives an expense the category it is recorded with, and other when none is given', async () => {
    const { ada, grace, groupId } = await setup();
    const groceries = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: {
        description: 'Shop',
        amount: 1000,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
        category: 'groceries',
      },
    });
    const plain = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: { description: 'Thing', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });

    expect((await readExpense(grace.token, groceries.json<{ id: string }>().id)).category).toBe('groceries');
    expect((await readExpense(grace.token, plain.json<{ id: string }>().id)).category).toBe('other');
  });

  it('lists every expense of the group with its category', async () => {
    const { ada, grace, groupId } = await setup();
    await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: {
        description: 'Rent',
        amount: 90000,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
        category: 'rent',
      },
    });

    const listed = await send(app, 'GET', `/groups/${groupId}/expenses`, { token: grace.token });
    expect(listed.json<{ category: string }[]>().map(expense => expense.category)).toEqual(['rent']);
  });

  it('refuses a category that is none of the categories, when recording or editing an expense', async () => {
    const { ada, grace, groupId } = await setup();
    const recorded = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: {
        description: 'Shop',
        amount: 1000,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
        category: 'snacks',
      },
    });
    expect(recorded.statusCode).toBe(422);
    expect(recorded.json()).toEqual({ type: 'InvalidCategory', message: expect.any(String) });

    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: { description: 'Shop', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    const id = expense.json<{ id: string }>().id;
    const edited = await send(app, 'PUT', `/expenses/${id}`, {
      token: ada.token,
      payload: {
        description: 'Shop',
        amount: 1000,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
        category: 'Groceries',
        version: 1,
      },
    });
    expect(edited.statusCode).toBe(422);
    expect(edited.json()).toEqual({ type: 'InvalidCategory', message: expect.any(String) });
    expect((await readExpense(ada.token, id)).category).toBe('other');
  });

  it('changes the category of an expense when it is edited, and an edit given none makes it other', async () => {
    const { ada, grace, groupId } = await setup();
    const created = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: {
        description: 'Shop',
        amount: 1000,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
        category: 'food',
      },
    });
    const id = created.json<{ id: string }>().id;
    const body = { description: 'Shop', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] };

    const toLeisure = await send(app, 'PUT', `/expenses/${id}`, {
      token: ada.token,
      payload: { ...body, category: 'leisure', version: 1 },
    });
    expect(toLeisure.statusCode).toBe(204);
    expect((await readExpense(grace.token, id)).category).toBe('leisure');

    const noCategory = await send(app, 'PUT', `/expenses/${id}`, {
      token: ada.token,
      payload: { ...body, version: 2 },
    });
    expect(noCategory.statusCode).toBe(204);
    expect((await readExpense(grace.token, id)).category).toBe('other');
  });

  it('gives the expenses a recurring expense records the category it is set up with, and other when none', async () => {
    const { ada, grace, groupId } = await setup();
    const startsOn = `${todayInUtc().slice(0, 8)}01`;
    const withCategory = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: ada.token,
      payload: {
        description: 'Rent',
        amount: 90000,
        startsOn,
        category: 'rent',
        splitBetween: [ada.id, grace.id],
      },
    });
    const withoutCategory = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: ada.token,
      payload: { description: 'Gym', amount: 3000, startsOn, splitBetween: [ada.id, grace.id] },
    });
    const rent = withCategory.json<{ id: string }>().id;
    const gym = withoutCategory.json<{ id: string }>().id;

    const read = await send(app, 'GET', `/recurring/${rent}`, { token: grace.token });
    expect(read.json()).toMatchObject({ id: rent, category: 'rent' });
    const readGym = await send(app, 'GET', `/recurring/${gym}`, { token: grace.token });
    expect(readGym.json()).toMatchObject({ id: gym, category: 'other' });

    await app.runJobs(new Date());
    const listed = await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ada.token });
    const byDescription = Object.fromEntries(
      listed
        .json<{ description: string; category: string }[]>()
        .map(expense => [expense.description, expense.category]),
    );
    expect(byDescription).toEqual({ Rent: 'rent', Gym: 'other' });
  });

  it('refuses a recurring expense whose category is none of the categories', async () => {
    const { ada, grace, groupId } = await setup();
    const response = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: ada.token,
      payload: {
        description: 'Rent',
        amount: 90000,
        startsOn: dayOfMonth(0, 1),
        category: 'housing',
        splitBetween: [ada.id, grace.id],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ type: 'InvalidCategory', message: expect.any(String) });
  });
});
