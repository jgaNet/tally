import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';
import { todayInUtc } from '../expenses/validation';

describe("a member's statement", () => {
  let app: Application;
  let databaseUrl: string;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    app = await createApplication({ databaseUrl });
  });

  afterEach(async () => {
    await app.stop();
  });

  const dayBefore = (day: string, days = 1): string =>
    new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

  async function createdGroup(token: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** An expense body; overrides replace its fields. */
  const expense = (overrides: Record<string, unknown> = {}) => ({
    description: 'Groceries',
    amount: 1000,
    date: todayInUtc(),
    splitBetween: [] as string[],
    ...overrides,
  });

  async function record(token: string, groupId: string, payload: Record<string, unknown>): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function statementOf(token: string, groupId: string, memberId: string) {
    return send(app, 'GET', `/groups/${groupId}/members/${memberId}/statement`, { token });
  }

  /** Ada owns a group with Grace and Linus in it, in that order; answers their ids and tokens. */
  async function threeMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    return { ada, grace, linus, groupId };
  }

  /**
   * Three expenses, in this order of recording:
   *  - 900 paid by Ada, two days ago, split three ways: 300 each;
   *  - 1000 paid by Grace, yesterday, split between Grace and Linus: 500 each;
   *  - 300 paid by Linus, today, split three ways: 100 each.
   */
  async function threeExpenses() {
    const members = await threeMembers();
    const { ada, grace, linus, groupId } = members;
    const today = todayInUtc();
    const first = await record(
      ada.token,
      groupId,
      expense({
        description: 'Dinner',
        amount: 900,
        date: dayBefore(today, 2),
        splitBetween: [ada.id, grace.id, linus.id],
      }),
    );
    const second = await record(
      grace.token,
      groupId,
      expense({ description: 'Taxi', amount: 1000, date: dayBefore(today), splitBetween: [grace.id, linus.id] }),
    );
    const third = await record(
      linus.token,
      groupId,
      expense({ description: 'Coffee', amount: 300, date: today, splitBetween: [ada.id, linus.id, grace.id] }),
    );
    return { ...members, first, second, third };
  }

  describe('its entries', () => {
    it('counts what the member paid and their share, and the balance after each entry', async () => {
      const { ada, groupId, first, third } = await threeExpenses();
      const response = await statementOf(ada.token, groupId, ada.id);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        memberId: ada.id,
        balance: 500,
        entries: [
          {
            kind: 'expense',
            expenseId: first,
            date: dayBefore(todayInUtc(), 2),
            description: 'Dinner',
            paid: 900,
            share: 300,
            balance: 600,
          },
          {
            kind: 'expense',
            expenseId: third,
            date: todayInUtc(),
            description: 'Coffee',
            paid: 0,
            share: 100,
            balance: 500,
          },
        ],
      });
    });

    it('leaves out an expense the member neither paid nor is in the split of', async () => {
      const { ada, groupId, second } = await threeExpenses();
      const entries = (await statementOf(ada.token, groupId, ada.id)).json().entries;
      expect(entries.map((entry: { kind: 'expense'; expenseId: string }) => entry.expenseId)).not.toContain(second);
    });

    it('includes an expense the member is in the split of, though someone else paid it', async () => {
      const { linus, groupId, second } = await threeExpenses();
      const entries = (await statementOf(linus.token, groupId, linus.id)).json().entries;
      const taxi = entries.find((entry: { kind: 'expense'; expenseId: string }) => entry.expenseId === second);
      expect(taxi).toEqual({
        kind: 'expense',
        expenseId: second,
        date: dayBefore(todayInUtc()),
        description: 'Taxi',
        paid: 0,
        share: 500,
        balance: -800,
      });
    });

    it('answers the earliest date first, and on the same date the earliest recorded first', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const today = todayInUtc();
      const today1 = await record(ada.token, groupId, expense({ date: today, splitBetween: [ada.id, grace.id] }));
      const older = await record(
        ada.token,
        groupId,
        expense({ date: dayBefore(today), splitBetween: [ada.id, grace.id] }),
      );
      const older2 = await record(
        grace.token,
        groupId,
        expense({ date: dayBefore(today), splitBetween: [ada.id, grace.id] }),
      );
      const oldest = await record(
        ada.token,
        groupId,
        expense({ date: dayBefore(today, 3), splitBetween: [ada.id, grace.id] }),
      );
      const ids = (await statementOf(ada.token, groupId, ada.id))
        .json()
        .entries.map((entry: { kind: 'expense'; expenseId: string }) => entry.expenseId);
      expect(ids).toEqual([oldest, older, older2, today1]);
    });

    it('gives an expense the member paid for, and is in the split of, one entry', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await record(ada.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id] }));
      const entries = (await statementOf(ada.token, groupId, ada.id)).json().entries;
      expect(entries).toEqual([
        {
          kind: 'expense',
          expenseId: id,
          date: todayInUtc(),
          description: 'Groceries',
          paid: 1000,
          share: 500,
          balance: 500,
        },
      ]);
    });

    it('is empty, with a balance of 0, for a member with nothing recorded', async () => {
      const { ada, linus, groupId } = await threeMembers();
      await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      const response = await statementOf(linus.token, groupId, linus.id);
      expect(response.json()).toEqual({ memberId: linus.id, balance: 0, entries: [] });
    });
  });

  describe('the settlements it has', () => {
    it('lists a cash settlement the balances count, as an entry of its own, from the day it is recorded', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const expenseId = await record(grace.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id] }));
      const settlement = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 200 },
      });
      expect(settlement.statusCode).toBe(201);
      const settlementId = settlement.json<{ id: string }>().id;
      const statement = (await statementOf(ada.token, groupId, ada.id)).json();
      expect(statement.entries).toEqual([
        {
          kind: 'expense',
          expenseId,
          date: todayInUtc(),
          description: 'Groceries',
          paid: 0,
          share: 500,
          balance: -500,
        },
        {
          kind: 'settlement',
          settlementId,
          date: todayInUtc(),
          description: 'Settlement in cash',
          paid: 200,
          share: 0,
          balance: -300,
        },
      ]);
      expect(statement.balance).toBe(-300);
    });

    it('gives the payee of a settlement its amount as the share, and a balance that goes up', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(grace.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id] }));
      const settlement = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 200 },
      });
      const settlementId = settlement.json<{ id: string }>().id;
      const entries = (await statementOf(grace.token, groupId, grace.id)).json().entries;
      expect(entries.at(-1)).toEqual({
        kind: 'settlement',
        settlementId,
        date: todayInUtc(),
        description: 'Settlement in cash',
        paid: 0,
        share: 200,
        balance: 300,
      });
    });

    it('orders a settlement among the expenses of its day by when the balances started to count it', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const first = await record(grace.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id] }));
      const settlement = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 200 },
      });
      const settlementId = settlement.json<{ id: string }>().id;
      const last = await record(grace.token, groupId, expense({ amount: 600, splitBetween: [ada.id, grace.id] }));
      const ids = (await statementOf(ada.token, groupId, ada.id))
        .json()
        .entries.map((entry: { expenseId?: string; settlementId?: string }) => entry.expenseId ?? entry.settlementId);
      expect(ids).toEqual([first, settlementId, last]);
    });
  });

  describe('its balance', () => {
    it("is the last entry's balance, and the balance the group's balances give the member", async () => {
      const { ada, grace, linus, groupId } = await threeExpenses();
      const balances = (await send(app, 'GET', `/groups/${groupId}/balances`, { token: ada.token })).json() as {
        memberId: string;
        balance: number;
      }[];
      for (const member of [ada, grace, linus]) {
        const statement = (await statementOf(ada.token, groupId, member.id)).json();
        const last = statement.entries.at(-1);
        expect(statement.balance).toBe(last ? last.balance : 0);
        expect(statement.balance).toBe(balances.find(row => row.memberId === member.id)?.balance);
      }
    });

    it('is 0 for a member whose entries come to nothing', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id] }));
      await record(grace.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id] }));
      const statement = (await statementOf(ada.token, groupId, ada.id)).json();
      expect(statement.entries.map((entry: { balance: number }) => entry.balance)).toEqual([500, 0]);
      expect(statement.balance).toBe(0);
    });
  });

  describe('edits and deletions', () => {
    it('counts an edited expense as it now stands', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const date = todayInUtc();
      const id = await record(ada.token, groupId, expense({ amount: 1000, date, splitBetween: [ada.id, grace.id] }));
      const edit = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: { description: 'Groceries', amount: 400, date, version: 1, splitBetween: [ada.id, grace.id] },
      });
      expect(edit.statusCode).toBe(204);
      const statement = (await statementOf(ada.token, groupId, ada.id)).json();
      expect(statement.entries).toEqual([
        { kind: 'expense', expenseId: id, date, description: 'Groceries', paid: 400, share: 200, balance: 200 },
      ]);
    });

    it('leaves out a deleted expense', async () => {
      const { ada, groupId, first, third } = await threeExpenses();
      expect((await send(app, 'DELETE', `/expenses/${first}`, { token: ada.token })).statusCode).toBe(204);
      const statement = (await statementOf(ada.token, groupId, ada.id)).json();
      expect(statement.entries.map((entry: { kind: 'expense'; expenseId: string }) => entry.expenseId)).toEqual([
        third,
      ]);
      expect(statement.balance).toBe(-100);
    });
  });

  describe('who reads it', () => {
    it('lets any member read the statement of any member, themselves included', async () => {
      const { ada, grace, linus, groupId } = await threeExpenses();
      for (const reader of [ada, grace, linus]) {
        for (const member of [ada, grace, linus]) {
          const response = await statementOf(reader.token, groupId, member.id);
          expect(response.statusCode).toBe(200);
          expect(response.json().memberId).toBe(member.id);
        }
      }
    });

    it('answers the same statement to every member', async () => {
      const { ada, grace, groupId } = await threeExpenses();
      const forAda = await statementOf(ada.token, groupId, grace.id);
      const forGrace = await statementOf(grace.token, groupId, grace.id);
      expect(forGrace.json()).toEqual(forAda.json());
    });

    it('answers 404 to a person who is not a member, the same as a group that does not exist', async () => {
      const { grace, groupId } = await threeExpenses();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const refused = await statementOf(eve.token, groupId, grace.id);
      const missing = await statementOf(eve.token, 'no-such-group', grace.id);
      expect(refused.statusCode).toBe(404);
      expect(refused.json().type).toBe('NotFound');
      expect(refused.json()).toEqual(missing.json());
    });

    it('answers 404 for a member of the group who has never been a member of it', async () => {
      const { ada, groupId } = await threeExpenses();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const notMember = await statementOf(ada.token, groupId, eve.id);
      const unknown = await statementOf(ada.token, groupId, 'no-such-account');
      expect(notMember.statusCode).toBe(404);
      expect(notMember.json().type).toBe('NotFound');
      expect(notMember.json()).toEqual(unknown.json());
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { ada, groupId } = await threeExpenses();
      expect((await send(app, 'GET', `/groups/${groupId}/members/${ada.id}/statement`)).statusCode).toBe(401);
      expect((await statementOf('not-a-real-token', groupId, ada.id)).statusCode).toBe(401);
    });
  });

  describe('reading it', () => {
    it('changes nothing: the same statement on every read', async () => {
      const { ada, groupId } = await threeExpenses();
      const first = await statementOf(ada.token, groupId, ada.id);
      const second = await statementOf(ada.token, groupId, ada.id);
      expect(second.json()).toEqual(first.json());
    });
  });
});
