import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';
import { todayInUtc } from './validation';

describe('amounts in the minor unit of their currency', () => {
  let app: Application;
  let databaseUrl: string;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    app = await createApplication({ databaseUrl });
  });

  afterEach(async () => {
    await app.stop();
  });

  /** Ada owns a group in `currency` with Grace in it; answers their ids and tokens, and the group's id. */
  async function twoMembersIn(currency: string) {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const created = await send(app, 'POST', '/groups', { token: ada.token, payload: { name: 'Trip', currency } });
    expect(created.statusCode).toBe(201);
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    return { ada, grace, groupId };
  }

  /** An expense of the group, paid by Ada and split equally between her and Grace, as `payload` says. */
  async function record(token: string, groupId: string, payload: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
  }

  async function expenseOf(token: string, id: string) {
    const response = await send(app, 'GET', `/expenses/${id}`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ amount: number; shares: { amount: number }[]; original?: Record<string, unknown> }>();
  }

  describe('a group in any of the ten currencies', () => {
    it.each(['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'KRW', 'KWD', 'BHD'])(
      'can be in %s, which it keeps',
      async currency => {
        const { ada, groupId } = await twoMembersIn(currency);
        const group = await send(app, 'GET', `/groups/${groupId}`, { token: ada.token });
        expect(group.json()).toMatchObject({ currency });
      },
    );
  });

  describe('the amount of an expense in the group’s currency', () => {
    it('is the whole number of yen it is: 1250 is 1250 yen, not 12.50', async () => {
      const { ada, grace, groupId } = await twoMembersIn('JPY');
      const created = await record(ada.token, groupId, {
        description: 'Ramen',
        amount: 1250,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      expect(created.statusCode).toBe(201);
      const expense = await expenseOf(ada.token, created.json<{ id: string }>().id);
      expect(expense.amount).toBe(1250);
      expect(expense.shares.map(share => share.amount)).toEqual([625, 625]);
    });

    it('is the whole number of thousandths of dinars it is: 1250 is 1.250 dinars', async () => {
      const { ada, grace, groupId } = await twoMembersIn('KWD');
      const created = await record(ada.token, groupId, {
        description: 'Coffee',
        amount: 1250,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      expect(created.statusCode).toBe(201);
      expect((await expenseOf(ada.token, created.json<{ id: string }>().id)).amount).toBe(1250);
    });

    it('still refuses an amount above 100 000 000 of the minor unit, whatever the currency', async () => {
      const { ada, grace, groupId } = await twoMembersIn('BHD');
      const response = await record(ada.token, groupId, {
        description: 'Too much',
        amount: 100_000_001,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('InvalidAmount');
    });
  });

  describe('an expense in another currency, converted into the group’s minor unit', () => {
    it.each([
      ['yen, from euros', 'JPY', { currency: 'EUR', amount: 1250, rate: '161.5' }, 2019],
      ['dinars, from dollars', 'KWD', { currency: 'USD', amount: 1000, rate: '0.3075' }, 3075],
      ['euros, from yen', 'EUR', { currency: 'JPY', amount: 10_000, rate: '0.0062' }, 6200],
      ['won, from euros', 'KRW', { currency: 'EUR', amount: 1250, rate: '1480.5' }, 18506],
      ['euros, from dinars', 'EUR', { currency: 'KWD', amount: 1000, rate: '2.95' }, 295],
      ['bahraini dinars, from yen', 'BHD', { currency: 'JPY', amount: 1000, rate: '0.0023' }, 2300],
    ])('is %s: the original at its rate, in the group’s minor unit', async (_, currency, original, expected) => {
      const { ada, grace, groupId } = await twoMembersIn(currency);
      const created = await record(ada.token, groupId, {
        description: 'Dinner',
        original,
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      expect(created.statusCode).toBe(201);
      const expense = await expenseOf(ada.token, created.json<{ id: string }>().id);
      expect(expense.amount).toBe(expected);
      expect(expense.original).toEqual(original);
      expect(expense.shares.reduce((sum, share) => sum + share.amount, 0)).toBe(expected);
    });

    it('rounds a half up to the nearest yen: 50 cents at 1 is half a yen, so 1', async () => {
      const { ada, grace, groupId } = await twoMembersIn('JPY');
      const created = await record(ada.token, groupId, {
        description: 'Coin',
        original: { currency: 'EUR', amount: 50, rate: '1' },
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      expect(created.statusCode).toBe(201);
      expect((await expenseOf(ada.token, created.json<{ id: string }>().id)).amount).toBe(1);
    });

    it('is refused when it converts to less than one yen, rounding below a half down', async () => {
      const { ada, grace, groupId } = await twoMembersIn('JPY');
      const response = await record(ada.token, groupId, {
        description: 'Coin',
        original: { currency: 'EUR', amount: 49, rate: '1' },
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('InvalidAmount');
    });

    it('takes the rate as a stated rate, when no rates service is set up, and keeps it', async () => {
      const { ada, grace, groupId } = await twoMembersIn('KWD');
      const created = await record(ada.token, groupId, {
        description: 'Taxi',
        original: { currency: 'USD', amount: 1000, rate: '0.3075' },
        date: todayInUtc(),
        splitBetween: [ada.id, grace.id],
      });
      expect(created.statusCode).toBe(201);
      expect((await expenseOf(ada.token, created.json<{ id: string }>().id)).original).toEqual({
        currency: 'USD',
        amount: 1000,
        rate: '0.3075',
      });
    });
  });
});
