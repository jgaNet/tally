import { DatabaseSync } from 'node:sqlite';
import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';
import { todayInUtc } from './validation';

describe('an expense in another currency', () => {
  let app: Application;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    app = await createApplication({ databasePath });
  });

  afterEach(async () => {
    await app.stop();
  });

  /** Ada owns a EUR group with Grace in it; answers their ids and tokens, and the group's id. */
  async function twoMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    return { ada, grace, groupId };
  }

  /** An expense body paid in another currency: `original` as given, split equally between the payer and Grace. */
  const inOther = (
    original: Record<string, unknown>,
    payer: { id: string },
    other: { id: string },
    overrides: Record<string, unknown> = {},
  ) => ({
    description: 'Dinner in Zurich',
    original: { currency: 'CHF', amount: 1234, rate: '1.0625', ...original },
    date: todayInUtc(),
    splitBetween: [payer.id, other.id],
    ...overrides,
  });

  async function record(token: string, groupId: string, payload: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
  }

  async function readExpense(token: string, expenseId: string) {
    return send(app, 'GET', `/expenses/${expenseId}`, { token });
  }

  async function recordedId(token: string, groupId: string, payload: Record<string, unknown>): Promise<string> {
    const response = await record(token, groupId, payload);
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  describe('recording it', () => {
    it('converts the original amount at the rate, rounded to the nearest whole number, and keeps both', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedId(ada.token, groupId, inOther({}, ada, grace));

      const expense = (await readExpense(ada.token, id)).json();
      // 1234 at 1.0625 is 1311.125, so 1311 in euros: split equally, the first member takes the remainder.
      expect(expense.amount).toBe(1311);
      expect(expense.original).toEqual({ currency: 'CHF', amount: 1234, rate: '1.0625' });
      expect(expense.shares).toEqual([
        { memberId: ada.id, amount: 656 },
        { memberId: grace.id, amount: 655 },
      ]);
      expect(expense.paidBy).toBe(ada.id);
    });

    it('rounds a half up: 1000 at 0.9545 is 954.5, so 955', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedId(ada.token, groupId, inOther({ amount: 1000, rate: '0.9545' }, ada, grace));
      expect((await readExpense(ada.token, id)).json().amount).toBe(955);
    });

    it('rounds a half up at the smallest amounts, and rounds below a half down', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const half = await recordedId(ada.token, groupId, inOther({ amount: 1, rate: '0.5' }, ada, grace));
      const threeHalves = await recordedId(ada.token, groupId, inOther({ amount: 3, rate: '0.5' }, ada, grace));
      expect((await readExpense(ada.token, half)).json().amount).toBe(1);
      expect((await readExpense(ada.token, threeHalves)).json().amount).toBe(2);

      const below = await record(ada.token, groupId, inOther({ amount: 1, rate: '0.499999' }, ada, grace));
      expect(below.statusCode).toBe(422);
      expect(below.json().type).toBe('InvalidAmount');
    });

    it('keeps the rate as the string it was given, and accepts a whole rate and one with a point', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const whole = await recordedId(ada.token, groupId, inOther({ amount: 800, rate: '1' }, ada, grace));
      const decimal = await recordedId(ada.token, groupId, inOther({ amount: 2, rate: '12.5' }, ada, grace));

      const wholeExpense = (await readExpense(ada.token, whole)).json();
      expect(wholeExpense.original.rate).toBe('1');
      expect(wholeExpense.amount).toBe(800);

      const decimalExpense = (await readExpense(ada.token, decimal)).json();
      expect(decimalExpense.original.rate).toBe('12.5');
      expect(decimalExpense.amount).toBe(25);
    });

    it('takes a rate of up to 6 digits after the point, exactly', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedId(ada.token, groupId, inOther({ amount: 100_000_000, rate: '0.000001' }, ada, grace));
      expect((await readExpense(ada.token, id)).json().amount).toBe(100);
    });

    it.each(['0', '0.000000', '00', '-1', '1.1234567', '1e3', '.5', '1.', 'abc', ' 1', ''])(
      'refuses the rate %j with 422, since it is not a decimal of up to 6 digits, or is not above 0',
      async rate => {
        const { ada, grace, groupId } = await twoMembers();
        const response = await record(ada.token, groupId, inOther({ rate }, ada, grace));
        expect(response.statusCode).toBe(422);
        expect(response.json().type).toBe('InvalidRate');
      },
    );

    it('refuses a rate that is sent as a number, since types are not converted', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const response = await record(ada.token, groupId, inOther({ rate: 1.0625 }, ada, grace));
      expect(response.statusCode).toBe(400);
      expect(response.json().type).toBe('InvalidBody');
    });

    it('refuses the group currency itself, and a currency Tally does not have, with 422', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const same = await record(ada.token, groupId, inOther({ currency: 'EUR' }, ada, grace));
      expect(same.statusCode).toBe(422);
      expect(same.json().type).toBe('InvalidOriginalCurrency');

      const unknown = await record(ada.token, groupId, inOther({ currency: 'JPY' }, ada, grace));
      expect(unknown.statusCode).toBe(422);
      expect(unknown.json().type).toBe('InvalidOriginalCurrency');
    });

    it.each([0, 100_000_001, 12.5])('refuses an original amount of %p with 422', async amount => {
      const { ada, grace, groupId } = await twoMembers();
      const response = await record(ada.token, groupId, inOther({ amount }, ada, grace));
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('InvalidOriginalAmount');
    });

    it('refuses a converted amount above 100 000 000, and one of 0, with 422', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const tooLarge = await record(ada.token, groupId, inOther({ amount: 100_000_000, rate: '2' }, ada, grace));
      expect(tooLarge.statusCode).toBe(422);
      expect(tooLarge.json().type).toBe('InvalidAmount');

      const zero = await record(ada.token, groupId, inOther({ amount: 1, rate: '0.4' }, ada, grace));
      expect(zero.statusCode).toBe(422);
      expect(zero.json().type).toBe('InvalidAmount');
    });

    it('accepts a converted amount of exactly 100 000 000', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedId(ada.token, groupId, inOther({ amount: 50_000_000, rate: '2' }, ada, grace));
      expect((await readExpense(ada.token, id)).json().amount).toBe(100_000_000);
    });

    it('is of the wrong shape with 400 when it has both an amount and an original, or neither', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const both = await record(ada.token, groupId, inOther({}, ada, grace, { amount: 1311 }));
      expect(both.statusCode).toBe(400);
      expect(both.json().type).toBe('InvalidBody');

      const payload: Record<string, unknown> = inOther({}, ada, grace);
      delete payload.original;
      const neither = await record(ada.token, groupId, payload);
      expect(neither.statusCode).toBe(400);
      expect(neither.json().type).toBe('InvalidBody');
    });

    it('is of the wrong shape with 400 when the original lacks its currency or its amount', async () => {
      const { ada, grace, groupId } = await twoMembers();
      // Its rate may be left out: it is then the offered one (see offered-rates.spec.ts).
      for (const field of ['currency', 'amount']) {
        const original: Record<string, unknown> = { currency: 'CHF', amount: 1234, rate: '1.0625' };
        delete original[field];
        const response = await record(ada.token, groupId, inOther({}, ada, grace, { original }));
        expect(response.statusCode).toBe(400);
        expect(response.json().type).toBe('InvalidBody');
      }
    });

    it('splits by the amount in the group currency, so exact amounts must add up to that', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const payload = {
        description: 'Dinner in Zurich',
        original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
        date: todayInUtc(),
      };
      const original = await record(ada.token, groupId, {
        ...payload,
        splitExactly: [
          { memberId: ada.id, amount: 1000 },
          { memberId: grace.id, amount: 311 },
        ],
      });
      expect(original.statusCode).toBe(201);

      const byOriginal = await record(ada.token, groupId, {
        ...payload,
        splitExactly: [
          { memberId: ada.id, amount: 1000 },
          { memberId: grace.id, amount: 234 },
        ],
      });
      expect(byOriginal.statusCode).toBe(422);
      expect(byOriginal.json().type).toBe('SharesDoNotAddUp');
    });

    it('counts the group-currency amount in the balances, and in the notices', async () => {
      const { ada, grace, groupId } = await twoMembers();
      await recordedId(ada.token, groupId, inOther({}, ada, grace));

      const balances = await send(app, 'GET', `/groups/${groupId}/balances`, { token: ada.token });
      expect(balances.json()).toEqual([
        { memberId: ada.id, balance: 655 },
        { memberId: grace.id, balance: -655 },
      ]);

      const notices = await send(app, 'GET', '/notices', { token: grace.token });
      expect(notices.json()).toEqual([expect.objectContaining({ kind: 'expense', groupId, amount: 655 })]);
    });
  });

  describe('an expense in the group currency', () => {
    it('reads without an original, as an expense did before', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedId(ada.token, groupId, {
        description: 'Groceries',
        amount: 1000,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      const expense = (await readExpense(ada.token, id)).json();
      expect(expense).not.toHaveProperty('original');
      expect(expense.amount).toBe(1000);
    });

    it('reads an expense recorded before the schema kept originals, as it was', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedId(ada.token, groupId, {
        description: 'Groceries',
        amount: 1000,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      await app.stop();

      // Takes the schema back to before this step, and the categories, budgets, split templates and receipts after it,
      // with the expense in it, and brings it up to date again.
      const db = new DatabaseSync(databasePath);
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      db.exec(`
        DROP TABLE receipts;
        DROP TABLE split_templates;
        DROP TABLE budget_passings;
        DROP TABLE budgets;
        ALTER TABLE expenses DROP COLUMN category;
        DROP TABLE recurring;
        ALTER TABLE expenses DROP COLUMN original_currency;
        ALTER TABLE expenses DROP COLUMN original_amount;
        ALTER TABLE expenses DROP COLUMN original_rate;
        PRAGMA user_version = ${version - 5};
      `);
      db.close();
      app = await createApplication({ databasePath });

      const expense = (await readExpense(ada.token, id)).json();
      expect(expense).not.toHaveProperty('original');
      expect(expense.amount).toBe(1000);
    });

    it('is of the wrong shape with 400 when it gives an amount and an original together', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const both = await record(ada.token, groupId, {
        description: 'Groceries',
        amount: 1000,
        original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      expect(both.statusCode).toBe(400);
      expect(both.json().type).toBe('InvalidBody');
    });
  });

  describe('editing it', () => {
    const edit = (version: number, payload: Record<string, unknown>) => ({
      description: 'Dinner in Zurich',
      date: todayInUtc(),
      version,
      splitBetween: [] as string[],
      ...payload,
    });

    it('changes it to another currency at a new rate, and it counts from then on', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedId(ada.token, groupId, {
        description: 'Dinner in Zurich',
        amount: 900,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });

      const edited = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: edit(1, {
          original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
          splitBetween: [ada.id, grace.id],
        }),
      });
      expect(edited.statusCode).toBe(204);

      const expense = (await readExpense(ada.token, id)).json();
      expect(expense.version).toBe(2);
      expect(expense.amount).toBe(1311);
      expect(expense.original).toEqual({ currency: 'CHF', amount: 1234, rate: '1.0625' });
    });

    it('keeps the rate exactly as an edit gives it, when it changes only the rate', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedId(ada.token, groupId, inOther({}, ada, grace));

      const edited = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: edit(1, {
          original: { currency: 'CHF', amount: 1234, rate: '1' },
          splitBetween: [ada.id, grace.id],
        }),
      });
      expect(edited.statusCode).toBe(204);

      const expense = (await readExpense(ada.token, id)).json();
      expect(expense.amount).toBe(1234);
      expect(expense.original).toEqual({ currency: 'CHF', amount: 1234, rate: '1' });
    });

    it('changes it back to the group currency, and it reads without an original again', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedId(ada.token, groupId, inOther({}, ada, grace));

      const edited = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: edit(1, { amount: 2000, splitBetween: [ada.id, grace.id] }),
      });
      expect(edited.statusCode).toBe(204);

      const expense = (await readExpense(ada.token, id)).json();
      expect(expense.amount).toBe(2000);
      expect(expense).not.toHaveProperty('original');
    });

    it('is refused with 400 when the edit has both an amount and an original, or neither', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedId(ada.token, groupId, inOther({}, ada, grace));

      const both = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: edit(1, {
          amount: 1000,
          original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
          splitBetween: [ada.id, grace.id],
        }),
      });
      expect(both.statusCode).toBe(400);

      const neither = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: edit(1, { splitBetween: [ada.id, grace.id] }),
      });
      expect(neither.statusCode).toBe(400);
      expect(neither.json().type).toBe('InvalidBody');

      expect((await readExpense(ada.token, id)).json().version).toBe(1);
    });

    it('refuses an edit whose rate is not valid, and keeps the expense as it was', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const id = await recordedId(ada.token, groupId, inOther({}, ada, grace));

      const refused = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: edit(1, {
          original: { currency: 'CHF', amount: 1234, rate: '0' },
          splitBetween: [ada.id, grace.id],
        }),
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().type).toBe('InvalidRate');

      const expense = (await readExpense(ada.token, id)).json();
      expect(expense.version).toBe(1);
      expect(expense.amount).toBe(1311);
      expect(expense.original).toEqual({ currency: 'CHF', amount: 1234, rate: '1.0625' });
    });
  });
});
