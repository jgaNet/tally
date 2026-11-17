import { DatabaseSync } from 'node:sqlite';
import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';
import { todayInUtc } from './validation';

describe('the remainder of an equal or shared split goes to the first member of the split', () => {
  let app: Application;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    app = await createApplication({ databasePath });
  });

  afterEach(async () => {
    await app.stop();
  });

  /** Ada owns a group with Grace and Linus in it, in that order; answers their ids and tokens. */
  async function threeMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    return { ada, grace, linus, groupId };
  }

  /** Overwrites the stored shares of an expense in the database file, as the rule before this change wrote them. */
  function storeSharesAsBefore(expenseId: string, shares: { memberId: string; amount: number }[]): void {
    const file = new DatabaseSync(databasePath);
    try {
      const update = file.prepare('UPDATE expense_shares SET amount = ? WHERE expense_id = ? AND member_id = ?');
      for (const share of shares) {
        update.run(share.amount, expenseId, share.memberId);
      }
    } finally {
      file.close();
    }
  }

  it('keeps the shares an expense recorded before the change was given, on every read and in the balances', async () => {
    const { ada, grace, linus, groupId } = await threeMembers();
    const recorded = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: grace.token,
      payload: {
        description: 'Dinner',
        amount: 1000,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id, linus.id],
      },
    });
    expect(recorded.statusCode).toBe(201);
    const expenseId = recorded.json<{ id: string }>().id;
    // Before the change, the payer, Grace, took the remainder.
    storeSharesAsBefore(expenseId, [
      { memberId: ada.id, amount: 333 },
      { memberId: grace.id, amount: 334 },
      { memberId: linus.id, amount: 333 },
    ]);

    // Reading it twice: a read changes nothing, so the shares stay as they were stored.
    for (let read = 0; read < 2; read++) {
      const response = await send(app, 'GET', `/expenses/${expenseId}`, { token: ada.token });
      expect(response.json().shares).toEqual([
        { memberId: ada.id, amount: 333 },
        { memberId: grace.id, amount: 334 },
        { memberId: linus.id, amount: 333 },
      ]);
    }
    const balances = await send(app, 'GET', `/groups/${groupId}/balances`, { token: ada.token });
    expect(balances.json()).toEqual([
      { memberId: ada.id, balance: -333 },
      { memberId: grace.id, balance: 666 },
      { memberId: linus.id, balance: -333 },
    ]);
  });

  it('splits an expense edited after the change by the new rule, the remainder to the first member', async () => {
    const { ada, grace, linus, groupId } = await threeMembers();
    const recorded = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: grace.token,
      payload: {
        description: 'Dinner',
        amount: 1000,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id, linus.id],
      },
    });
    const expenseId = recorded.json<{ id: string }>().id;
    storeSharesAsBefore(expenseId, [
      { memberId: ada.id, amount: 333 },
      { memberId: grace.id, amount: 334 },
      { memberId: linus.id, amount: 333 },
    ]);

    const edited = await send(app, 'PUT', `/expenses/${expenseId}`, {
      token: grace.token,
      payload: {
        description: 'Dinner',
        amount: 1000,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id, linus.id],
        version: 1,
      },
    });
    expect(edited.statusCode).toBe(204);

    const read = await send(app, 'GET', `/expenses/${expenseId}`, { token: ada.token });
    expect(read.json()).toMatchObject({
      version: 2,
      shares: [
        { memberId: ada.id, amount: 334 },
        { memberId: grace.id, amount: 333 },
        { memberId: linus.id, amount: 333 },
      ],
    });
  });

  it('gives the remainder of a shares split to the first member, whoever paid, and the shares add up to the amount', async () => {
    const { ada, grace, linus, groupId } = await threeMembers();
    const recorded = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: linus.token,
      payload: {
        description: 'Tickets',
        amount: 100,
        date: todayInUtc(),
        splitByShares: [
          { memberId: grace.id, shares: 1 },
          { memberId: linus.id, shares: 1 },
          { memberId: ada.id, shares: 1 },
        ],
      },
    });
    expect(recorded.statusCode).toBe(201);
    const read = await send(app, 'GET', `/expenses/${recorded.json<{ id: string }>().id}`, { token: ada.token });
    expect(read.json().shares).toEqual([
      { memberId: grace.id, amount: 34 },
      { memberId: linus.id, amount: 33 },
      { memberId: ada.id, amount: 33 },
    ]);
  });
});
