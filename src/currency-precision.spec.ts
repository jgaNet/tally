import { Application } from './app';
import { minorUnitDigits } from './groups';
import { convertedAmount, rateMillionths } from './rates';
import { reminderThreshold } from './reminders';
import { feeInGroupCurrency, type Pricing } from './settlements';
import { ada, call, FakeRates, startApplication, startFakeRates, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (days: number) => new Date(T0 + days * DAY);

describe('currencies of their own minor unit', () => {
  describe('the minor unit and the conversion, as functions', () => {
    it('counts the euro and the dollar in hundredths, the yen and the won in units, the dinar and the bahraini dinar in thousandths', () => {
      expect(['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'].map(minorUnitDigits)).toEqual([2, 2, 2, 2, 2, 2]);
      expect(['JPY', 'KRW'].map(minorUnitDigits)).toEqual([0, 0]);
      expect(['KWD', 'BHD'].map(minorUnitDigits)).toEqual([3, 3]);
    });

    it('converts by what one unit of each currency is worth, as the request gives it', () => {
      const millionths = (rate: string) => rateMillionths(rate) as bigint;
      // 12.50 euros in yen at 161.5 is 2018.75 yen, so 2019.
      expect(convertedAmount(1250, 'EUR', 'JPY', millionths('161.5'))).toBe(2019n);
      // 10 dollars in dinars at 0.3075 is 3.075 dinars, so 3075 thousandths.
      expect(convertedAmount(1000, 'USD', 'KWD', millionths('0.3075'))).toBe(3075n);
      // 10 000 yen in euros at 0.0062 is 62 euros, so 6200 hundredths.
      expect(convertedAmount(10000, 'JPY', 'EUR', millionths('0.0062'))).toBe(6200n);
      // Between two currencies of the same minor unit, nothing changes: 10 euros at 1.0625 is 10.625 francs.
      expect(convertedAmount(1000, 'EUR', 'CHF', millionths('1.0625'))).toBe(1063n);
    });

    it('rounds to the nearest whole number of the minor unit, a half rounded up', () => {
      expect(convertedAmount(50, 'EUR', 'JPY', 1_000_000n)).toBe(1n); // 0.50 yen is 1
      expect(convertedAmount(49, 'EUR', 'JPY', 1_000_000n)).toBe(0n); // 0.49 yen is 0
      expect(convertedAmount(5, 'JPY', 'KWD', 1_000_000n)).toBe(5000n); // 5 yen at one dinar a yen is 5 dinars, 5000 thousandths
    });

    it('takes the fee in the minor unit of the payment, converted to the group’s currency as the settlement is', () => {
      // Paid 10 000 yen at 0.0062 for 6200 hundredths of euros; the provider's fee of 5 000 yen is 31 euros, 3100 hundredths.
      const pricing: Pricing = {
        amount: 6200,
        original: { currency: 'JPY', amount: 10000, rate: '0.0062' },
        millionths: 6200n,
      };
      expect(feeInGroupCurrency(pricing, 5000, 'EUR')).toBe(3100);
      // A settlement in the group's own currency keeps its fee as it is.
      expect(feeInGroupCurrency({ amount: 6200 }, 100, 'EUR')).toBe(100);
    });

    it('is a reminder above 20 of the group’s currency, in its minor unit', () => {
      expect(reminderThreshold('EUR')).toBe(2000);
      expect(reminderThreshold('JPY')).toBe(20);
      expect(reminderThreshold('KRW')).toBe(20);
      expect(reminderThreshold('KWD')).toBe(20000);
      expect(reminderThreshold('BHD')).toBe(20000);
    });
  });

  describe('through the API', () => {
    let database: ReturnType<typeof temporaryDatabase>;
    let app: Application;
    let rates: FakeRates;
    let adaId: string;
    let adaToken: string;
    let graceId: string;
    let graceToken: string;

    async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
      const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
      const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
      return { id, token };
    }

    /** A group of the currency that Ada owns and Grace has joined. */
    async function groupIn(currency: string): Promise<string> {
      const id = (await call(app, 'POST', '/groups', { body: { name: `In ${currency}`, currency }, token: adaToken }))
        .body.id;
      const invitation = await call(app, 'POST', `/groups/${id}/invitations`, { token: adaToken });
      await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: graceToken });
      return id;
    }

    const offers = (rate: string) => {
      rates.answer = () => ({ status: 200, body: { rate } });
    };

    beforeEach(async () => {
      database = temporaryDatabase();
      rates = await startFakeRates();
      app = await startApplication(database.url, { ratesUrl: rates.url, ratesTimeoutMs: 300 });
      ({ id: adaId, token: adaToken } = await accountOf(ada));
      ({ id: graceId, token: graceToken } = await accountOf(grace));
    });

    afterEach(async () => {
      await app.stop();
      await rates.stop();
      await database.remove();
    });

    it('creates a group in JPY, KRW, KWD or BHD, and reads it back in that currency', async () => {
      for (const currency of ['JPY', 'KRW', 'KWD', 'BHD']) {
        const id = await groupIn(currency);
        expect(await call(app, 'GET', `/groups/${id}`, { token: adaToken })).toMatchObject({
          status: 200,
          body: { currency },
        });
      }
    });

    it('records an expense in a yen group in yen, as a whole number of yen', async () => {
      const group = await groupIn('JPY');
      const recorded = await call(app, 'POST', `/groups/${group}/expenses`, {
        body: { description: 'Sushi', amount: 1250, date: '2026-11-01', splitBetween: [adaId, graceId] },
        token: adaToken,
      });
      expect(recorded.status).toBe(201);
      expect(await call(app, 'GET', `/expenses/${recorded.body.id}`, { token: adaToken })).toMatchObject({
        body: { amount: 1250, shares: [{ amount: 625 }, { amount: 625 }] },
      });
    });

    it('takes an amount from 1 to 100 000 000 of a yen, and refuses 100 000 001', async () => {
      const group = await groupIn('JPY');
      const record = (amount: number) =>
        call(app, 'POST', `/groups/${group}/expenses`, {
          body: { description: 'Sushi', amount, date: '2026-11-01', splitBetween: [adaId] },
          token: adaToken,
        });
      expect((await record(100_000_000)).status).toBe(201);
      expect((await record(100_000_001)).status).toBe(422);
    });

    it('converts 12.50 euros into a yen group at 161.5, to 2019 yen, and keeps the original', async () => {
      offers('161.5');
      const group = await groupIn('JPY');
      const recorded = await call(app, 'POST', `/groups/${group}/expenses`, {
        body: {
          description: 'Ramen',
          original: { currency: 'EUR', amount: 1250, rate: '161.5' },
          date: '2026-11-01',
          splitBetween: [adaId],
        },
        token: adaToken,
      });
      expect(recorded.status).toBe(201);
      expect(await call(app, 'GET', `/expenses/${recorded.body.id}`, { token: adaToken })).toMatchObject({
        body: { amount: 2019, original: { currency: 'EUR', amount: 1250, rate: '161.5' } },
      });
    });

    it('converts 10 dollars into a dinar group at 0.3075, to 3075 thousandths', async () => {
      offers('0.3075');
      const group = await groupIn('KWD');
      const recorded = await call(app, 'POST', `/groups/${group}/expenses`, {
        body: {
          description: 'Taxi',
          original: { currency: 'USD', amount: 1000, rate: '0.3075' },
          date: '2026-11-01',
          splitBetween: [adaId],
        },
        token: adaToken,
      });
      expect(recorded.status).toBe(201);
      expect(await call(app, 'GET', `/expenses/${recorded.body.id}`, { token: adaToken })).toMatchObject({
        body: { amount: 3075 },
      });
    });

    it('converts 10 000 yen into a euro group at 0.0062, to 6200 hundredths, and refuses an amount that rounds to 0', async () => {
      offers('0.0062');
      const group = await groupIn('EUR');
      const recorded = await call(app, 'POST', `/groups/${group}/expenses`, {
        body: {
          description: 'Gift',
          original: { currency: 'JPY', amount: 10000, rate: '0.0062' },
          date: '2026-11-01',
          splitBetween: [adaId],
        },
        token: adaToken,
      });
      expect(recorded.status).toBe(201);
      expect(await call(app, 'GET', `/expenses/${recorded.body.id}`, { token: adaToken })).toMatchObject({
        body: { amount: 6200 },
      });
      // One yen at 0.000001 is a millionth of a euro, which rounds to no hundredth: refused, as an amount of 0.
      offers('0.000001');
      const tiny = await call(app, 'POST', `/groups/${group}/expenses`, {
        body: {
          description: 'Sweets',
          original: { currency: 'JPY', amount: 1, rate: '0.000001' },
          date: '2026-11-01',
          splitBetween: [adaId],
        },
        token: adaToken,
      });
      expect(tiny).toMatchObject({ status: 422, body: { type: 'InvalidAmount' } });
    });

    it('pays a settlement in yen in a yen group, paid in euros at the rate offered, at the rounded amount', async () => {
      offers('161.5');
      const group = await groupIn('JPY');
      // Ada paid 10 000 yen split equally: Grace owes Ada 5 000 yen.
      await call(app, 'POST', `/groups/${group}/expenses`, {
        body: { description: 'Trip', amount: 10000, date: '2026-11-01', splitBetween: [adaId, graceId] },
        token: adaToken,
      });
      const paid = await call(app, 'POST', `/groups/${group}/settlements/cash`, {
        body: { from: graceId, original: { currency: 'EUR', amount: 1250 } },
        token: adaToken,
      });
      expect(paid.status).toBe(201);
      expect(await call(app, 'GET', `/settlements/${paid.body.id}`, { token: adaToken })).toMatchObject({
        body: { amount: 2019, original: { currency: 'EUR', amount: 1250, rate: '161.5' } },
      });
    });

    it('offers the rate between a yen and the group’s currency, and asks the rates service in those currencies', async () => {
      offers('0.0062');
      const euros = await groupIn('EUR');
      expect(await call(app, 'GET', `/groups/${euros}/rates/JPY?date=2026-11-01`, { token: adaToken })).toEqual({
        status: 200,
        body: { currency: 'JPY', date: '2026-11-01', rate: '0.0062' },
      });
      expect(rates.requests).toEqual([{ from: 'JPY', to: 'EUR', date: '2026-11-01' }]);
    });

    it('reminds a member owing more than 20 yen, and not one owing 20 yen', async () => {
      const group = await groupIn('JPY');
      await call(app, 'POST', `/groups/${group}/expenses`, {
        body: { description: 'Rent', amount: 42, date: '2026-11-01', splitBetween: [adaId, graceId] },
        token: adaToken,
      });
      await app.runJobs(at(0));
      await app.runJobs(at(7));
      const notices = (await call(app, 'GET', '/notices', { token: graceToken })).body as Array<{
        kind: string;
        amount: number;
      }>;
      expect(notices.filter(n => n.kind === 'reminder')).toEqual([
        expect.objectContaining({ kind: 'reminder', amount: 21 }),
      ]);
    });

    it('does not remind a member owing 20 yen', async () => {
      const group = await groupIn('JPY');
      await call(app, 'POST', `/groups/${group}/expenses`, {
        body: { description: 'Rent', amount: 40, date: '2026-11-01', splitBetween: [adaId, graceId] },
        token: adaToken,
      });
      await app.runJobs(at(0));
      await app.runJobs(at(7));
      expect(
        ((await call(app, 'GET', '/notices', { token: graceToken })).body as Array<{ kind: string }>).filter(
          n => n.kind === 'reminder',
        ),
      ).toEqual([]);
    });

    it('reminds a member owing more than 20 dinars, in thousandths', async () => {
      const group = await groupIn('KWD');
      // The expense of 40 002 thousandths, split in two: Grace owes 20 001, which is more than 20 000.
      await call(app, 'POST', `/groups/${group}/expenses`, {
        body: { description: 'Car', amount: 40002, date: '2026-11-01', splitBetween: [adaId, graceId] },
        token: adaToken,
      });
      await app.runJobs(at(0));
      await app.runJobs(at(7));
      const notices = (await call(app, 'GET', '/notices', { token: graceToken })).body as Array<{
        kind: string;
        amount: number;
      }>;
      expect(notices.filter(n => n.kind === 'reminder')).toEqual([
        expect.objectContaining({ kind: 'reminder', amount: 20001 }),
      ]);
    });
  });
});
