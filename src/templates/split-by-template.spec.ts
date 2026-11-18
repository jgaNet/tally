import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';

describe('expenses split by a template', () => {
  let app: Application;

  beforeEach(async () => {
    app = await createApplication({ databasePath: temporaryDatabasePath() });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function setup() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, cy.token, groupId);
    return { ada, grace, cy, groupId };
  }

  const saveTemplate = async (token: string, groupId: string, payload: object): Promise<string> => {
    const response = await send(app, 'POST', `/groups/${groupId}/templates`, { token, payload });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  };

  const recordWith = (token: string, groupId: string, payload: object) =>
    send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      payload: { description: 'Shop', amount: 1000, date: todayInUtc(), ...payload },
    });

  async function expenseOf(token: string, expenseId: string) {
    const response = await send(app, 'GET', `/expenses/${expenseId}`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{
      version: number;
      splitKind: string;
      shares: { memberId: string; amount: number }[];
    }>();
  }

  it('splits an expense equally by an equal template, as if its split had been given', async () => {
    const { ada, grace, groupId } = await setup();
    const flat = await saveTemplate(ada.token, groupId, { name: 'Flat', splitBetween: [ada.id, grace.id] });

    const recorded = await recordWith(ada.token, groupId, { template: flat });
    expect(recorded.statusCode).toBe(201);
    const expense = await expenseOf(grace.token, recorded.json<{ id: string }>().id);
    expect(expense.splitKind).toBe('equal');
    expect(expense.version).toBe(1);
    expect(expense.shares).toEqual([
      { memberId: ada.id, amount: 500 },
      { memberId: grace.id, amount: 500 },
    ]);
  });

  it('splits an expense by a template of shares, and keeps how it was split and its shares', async () => {
    const { ada, grace, groupId } = await setup();
    const rent = await saveTemplate(ada.token, groupId, {
      name: 'Rent',
      splitByShares: [
        { memberId: ada.id, shares: 2 },
        { memberId: grace.id, shares: 1 },
      ],
    });

    const recorded = await recordWith(grace.token, groupId, { template: rent, amount: 1000 });
    expect(recorded.statusCode).toBe(201);
    const expense = await expenseOf(ada.token, recorded.json<{ id: string }>().id);
    expect(expense.splitKind).toBe('shares');
    expect(expense.shares).toEqual([
      { memberId: ada.id, amount: 667 },
      { memberId: grace.id, amount: 333 },
    ]);
  });

  it('keeps an expense as it was split when its template is changed or removed later', async () => {
    const { ada, grace, groupId } = await setup();
    const flat = await saveTemplate(ada.token, groupId, { name: 'Flat', splitBetween: [ada.id, grace.id] });
    const recorded = await recordWith(ada.token, groupId, { template: flat });
    const expenseId = recorded.json<{ id: string }>().id;
    const before = await expenseOf(ada.token, expenseId);

    expect(
      (
        await send(app, 'PUT', `/templates/${flat}`, {
          token: ada.token,
          payload: { name: 'Flat', splitByShares: [{ memberId: ada.id, shares: 1 }] },
        })
      ).statusCode,
    ).toBe(204);
    expect(await expenseOf(ada.token, expenseId)).toEqual(before);

    expect((await send(app, 'DELETE', `/templates/${flat}`, { token: ada.token })).statusCode).toBe(204);
    expect(await expenseOf(ada.token, expenseId)).toEqual(before);
  });

  it('splits an edited expense by a template, from the version its author read', async () => {
    const { ada, grace, groupId } = await setup();
    const flat = await saveTemplate(ada.token, groupId, { name: 'Flat', splitBetween: [ada.id, grace.id] });
    const rent = await saveTemplate(ada.token, groupId, {
      name: 'Rent',
      splitByShares: [
        { memberId: ada.id, shares: 1 },
        { memberId: grace.id, shares: 3 },
      ],
    });
    const expenseId = (await recordWith(ada.token, groupId, { template: flat })).json<{ id: string }>().id;

    const edited = await send(app, 'PUT', `/expenses/${expenseId}`, {
      token: ada.token,
      payload: { description: 'Shop', amount: 1000, date: todayInUtc(), version: 1, template: rent },
    });
    expect(edited.statusCode).toBe(204);
    const expense = await expenseOf(grace.token, expenseId);
    expect(expense.version).toBe(2);
    expect(expense.splitKind).toBe('shares');
    expect(expense.shares).toEqual([
      { memberId: ada.id, amount: 250 },
      { memberId: grace.id, amount: 750 },
    ]);

    const stale = await send(app, 'PUT', `/expenses/${expenseId}`, {
      token: ada.token,
      payload: { description: 'Shop', amount: 1000, date: todayInUtc(), version: 1, template: flat },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("refuses a template of another group, or one that is not there, as not one of the group's templates", async () => {
    const { ada, grace, groupId } = await setup();
    const other = await send(app, 'POST', '/groups', {
      token: grace.token,
      payload: { name: 'Club', currency: 'EUR' },
    });
    const otherGroupId = other.json<{ id: string }>().id;
    const elsewhere = await saveTemplate(grace.token, otherGroupId, { name: 'Club', splitBetween: [grace.id] });

    for (const template of [elsewhere, '00000000-0000-4000-8000-000000000000']) {
      const response = await recordWith(ada.token, groupId, { template });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ type: 'NoSuchTemplate', message: expect.any(String) });
    }
    expect((await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ada.token })).json()).toEqual([]);
  });

  it('refuses an expense whose template names a member who has left, or whose payer is not in the template', async () => {
    const { ada, grace, cy, groupId } = await setup();
    const withGrace = await saveTemplate(ada.token, groupId, { name: 'Grace', splitBetween: [ada.id, grace.id] });
    const withoutAda = await saveTemplate(ada.token, groupId, { name: 'Cy', splitBetween: [grace.id, cy.id] });

    const notPaying = await recordWith(ada.token, groupId, { template: withoutAda });
    expect(notPaying.statusCode).toBe(422);
    expect(notPaying.json()).toEqual({ type: 'PayerNotInSplit', message: expect.any(String) });

    expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: grace.token })).statusCode).toBe(204);
    const left = await recordWith(ada.token, groupId, { template: withGrace });
    expect(left.statusCode).toBe(422);
    expect(left.json()).toEqual({ type: 'NotAMember', message: expect.any(String) });
  });

  it('refuses an expense that gives a template together with a split, or with none of the splits and template', async () => {
    const { ada, grace, groupId } = await setup();
    const flat = await saveTemplate(ada.token, groupId, { name: 'Flat', splitBetween: [ada.id, grace.id] });

    const both = await recordWith(ada.token, groupId, { template: flat, splitBetween: [ada.id, grace.id] });
    expect(both.statusCode).toBe(400);
    expect(both.json()).toEqual({ type: 'InvalidBody', message: expect.any(String) });

    const neither = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: { description: 'Shop', amount: 1000, date: todayInUtc() },
    });
    expect(neither.statusCode).toBe(400);
    expect(neither.json()).toEqual({ type: 'InvalidBody', message: expect.any(String) });
  });
});
