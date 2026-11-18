import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Application, createApplication } from './app';
import { type Database, openDatabase } from './database';
import { convertedAmount } from './expenses';
import { minorUnitDigitsOf, type Currency } from './currencies';
import { reminderThresholdOf } from './reminders';
import {
  ensureDatabase,
  send,
  signedUpAccount,
  startApplication,
  testDirectory,
  type TestDirectory,
} from './test-helpers';

const SECRET = 'shared with the provider';
const WEEK_SECONDS = 604_800;
const WEEK_MS = WEEK_SECONDS * 1000;
const START = Date.parse('2026-11-02T09:00:00.000Z');

/** The rates the fake rates service offers, by `from/to`: what one unit of `from` is worth in `to`. */
const OFFERS: Record<string, string> = {
  'EUR/JPY': '161.5',
  'JPY/EUR': '0.0062',
  'USD/KWD': '0.3075',
};

/** The webhook signature the provider puts on a body: HMAC-SHA256, in lowercase hexadecimal. */
function signed(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('amounts in the minor unit of their currency', () => {
  describe('the minor unit of each currency', () => {
    it('has hundredths in the six currencies, no minor unit in yen and won, and thousandths in dinars', () => {
      for (const currency of ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const) {
        expect(minorUnitDigitsOf(currency)).toBe(2);
      }
      expect(minorUnitDigitsOf('JPY')).toBe(0);
      expect(minorUnitDigitsOf('KRW')).toBe(0);
      expect(minorUnitDigitsOf('KWD')).toBe(3);
      expect(minorUnitDigitsOf('BHD')).toBe(3);
    });

    it('reminds above 20 of the group’s currency: 2000 hundredths, 20 yen or won, 20 000 thousandths', () => {
      expect(reminderThresholdOf('EUR')).toBe(2000);
      expect(reminderThresholdOf('CHF')).toBe(2000);
      expect(reminderThresholdOf('JPY')).toBe(20);
      expect(reminderThresholdOf('KRW')).toBe(20);
      expect(reminderThresholdOf('KWD')).toBe(20_000);
      expect(reminderThresholdOf('BHD')).toBe(20_000);
    });
  });

  describe('converting between currencies of different minor units', () => {
    it('is 2018.75 yen for 1250 euros at 161.5, so 2019', () => {
      expect(convertedAmount(1250, '161.5', 'EUR', 'JPY')).toBe(2019);
    });

    it('is 3.075 dinars for 10 dollars at 0.3075, so 3075', () => {
      expect(convertedAmount(1000, '0.3075', 'USD', 'KWD')).toBe(3075);
    });

    it('is 62 euros for 10 000 yen at 0.0062, so 6200', () => {
      expect(convertedAmount(10_000, '0.0062', 'JPY', 'EUR')).toBe(6200);
    });

    it('rounds a half up across minor units: 1 cent at 50 is half a yen, so 1; 1 yen at 0.005 is half a cent, so 1', () => {
      expect(convertedAmount(1, '50', 'EUR', 'JPY')).toBe(1);
      expect(convertedAmount(1, '0.005', 'JPY', 'EUR')).toBe(1);
    });

    it('keeps the amount of a conversion whose minor units are the same as before', () => {
      expect(convertedAmount(1234, '1.0625', 'CHF', 'EUR')).toBe(1311);
      expect(convertedAmount(1000, '0.9545', 'CHF', 'EUR')).toBe(955);
    });
  });

  describe('through the API', () => {
    let directory: TestDirectory;
    let app: Application;
    let db: Database;
    let rates: Server;
    let ratesUrl: string;
    let provider: Server;
    let providerUrl: string;
    let providerFee: number;
    let payments: number;
    /** The time the application's clock tells; moved by the tests. */
    let now: number;

    async function startAt(): Promise<Application> {
      await ensureDatabase(directory.databaseUrl);
      const started = await createApplication({
        databaseUrl: directory.databaseUrl,
        ratesUrl,
        ratesTimeoutMs: 200,
        providerUrl,
        providerWebhookSecret: SECRET,
        providerTimeoutMs: 200,
        reminderPeriodSeconds: WEEK_SECONDS,
        clock: () => new Date(now),
      });
      await started.start(0);
      return started;
    }

    beforeEach(async () => {
      now = START;
      payments = 0;
      providerFee = 0;
      directory = testDirectory();
      rates = createServer((request, response) => {
        const [, , from, to] = new URL(request.url ?? '', 'http://rates.test').pathname.split('/');
        const rate = OFFERS[`${from}/${to}`];
        response.writeHead(rate === undefined ? 404 : 200, { 'content-type': 'application/json' });
        response.end(rate === undefined ? '' : JSON.stringify({ rate }));
      });
      await new Promise<void>(resolve => rates.listen(0, '127.0.0.1', resolve));
      ratesUrl = `http://127.0.0.1:${(rates.address() as AddressInfo).port}`;
      provider = createServer((request, response) => {
        let raw = '';
        request.on('data', chunk => (raw += chunk));
        request.on('end', () => {
          const json = { 'content-type': 'application/json' };
          const path = request.url ?? '';
          if (path.startsWith('/accounts/')) {
            response.writeHead(200, json);
            response.end(JSON.stringify({ id: decodeURIComponent(path.slice('/accounts/'.length)) }));
            return;
          }
          const n = ++payments;
          response.writeHead(201, json);
          response.end(JSON.stringify({ id: `pay_${n}`, payUrl: `https://pay.example.org/${n}`, fee: providerFee }));
        });
      });
      await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
      providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
      app = await startAt();
      db = await openDatabase({ url: directory.databaseUrl });
    });

    afterEach(async () => {
      await db.close();
      await app.stop();
      await new Promise<void>(resolve => rates.close(() => resolve()));
      rates.closeAllConnections();
      await new Promise<void>(resolve => provider.close(() => resolve()));
      provider.closeAllConnections();
      await directory.remove();
    });

    /** Creates a group in `currency` as `token`'s account and answers its id. */
    async function createGroup(token: string, currency: Currency, name = 'Trip'): Promise<string> {
      const reply = await send(app, 'POST', '/groups', { token, body: { name, currency } });
      if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
      return (reply.body as { id: string }).id;
    }

    /** Makes the account of `joinerToken` a member of `groupId`, through an invitation its owner creates. */
    async function join(ownerToken: string, groupId: string, joinerToken: string): Promise<void> {
      const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ownerToken });
      const accepted = await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, {
        token: joinerToken,
      });
      if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
    }

    /** Two accounts in a group of `currency`: Ann owns it, Ben joined it. */
    async function annAndBen(currency: Currency) {
      const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const groupId = await createGroup(ann.token, currency);
      await join(ann.token, groupId, ben.token);
      return { ann, ben, groupId };
    }

    /** Records an expense as `token`'s account, answering its id. */
    async function recordExpense(token: string, groupId: string, body: unknown): Promise<string> {
      const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, body });
      if (reply.status !== 201) throw new Error(`record answered ${reply.status}: ${JSON.stringify(reply.body)}`);
      return (reply.body as { id: string }).id;
    }

    /** The balances of `groupId`, read as `token`'s account, as a map from member to balance. */
    async function balancesAs(token: string, groupId: string): Promise<Record<string, number>> {
      const reply = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
      const rows = reply.body as { memberId: string; balance: number }[];
      return Object.fromEntries(rows.map(row => [row.memberId, row.balance]));
    }

    /** The reminders of `token`'s account, as the API answers them. */
    async function remindersOf(token: string): Promise<Record<string, unknown>[]> {
      const reply = await send(app, 'GET', '/notices', { token });
      return (reply.body as Record<string, unknown>[]).filter(notice => notice.kind === 'reminder');
    }

    /** Tells the provider a payment succeeded, as its signed webhook does. */
    async function paymentSucceeded(paymentId: string): Promise<void> {
      const body = JSON.stringify({
        id: `evt_${paymentId}`,
        paymentId,
        status: 'succeeded',
        at: new Date().toISOString(),
      });
      await fetch(`${app.address}/${app.apiPrefix}/provider/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'provider-signature': signed(body) },
        body,
      });
    }

    describe('groups', () => {
      it('allows a group in yen, won, dinars or Bahraini dinars, and refuses another currency', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        for (const currency of ['JPY', 'KRW', 'KWD', 'BHD']) {
          const reply = await send(app, 'POST', '/groups', { token: ana.token, body: { name: 'Trip', currency } });
          expect(reply.status).toBe(201);
          const id = (reply.body as { id: string }).id;
          const read = await send(app, 'GET', `/groups/${id}`, { token: ana.token });
          expect(read.body).toMatchObject({ currency });
        }
        const refused = await send(app, 'POST', '/groups', {
          token: ana.token,
          body: { name: 'Trip', currency: 'XYZ' },
        });
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({ error: 'CurrencyIsUnsupported' });
      });

      it('accepts yen and won in a database whose currency CHECKs named the six only, replacing them once', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        // A database created before the four currencies kept the CHECKs of the currencies with the six only.
        await db.exec(`
          ALTER TABLE groups DROP CONSTRAINT groups_currency_check,
            ADD CONSTRAINT groups_currency_check CHECK (currency IN ('EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'));
          ALTER TABLE nettings DROP CONSTRAINT nettings_currency_check,
            ADD CONSTRAINT nettings_currency_check CHECK (currency IN ('EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'));
        `);
        await app.stop();
        app = await startApplication(directory.databaseUrl);
        const reply = await send(app, 'POST', '/groups', {
          token: ana.token,
          body: { name: 'Tokyo', currency: 'JPY' },
        });
        expect(reply.status).toBe(201);
        // A second start changes nothing more.
        await app.stop();
        app = await startApplication(directory.databaseUrl);
        const again = await send(app, 'POST', '/groups', {
          token: ana.token,
          body: { name: 'Seoul', currency: 'KRW' },
        });
        expect(again.status).toBe(201);
      });
    });

    describe('rates', () => {
      it('offers the rate from yen to a euro group, and from euros to a yen group, as any other currency', async () => {
        const { ann, groupId } = await annAndBen('EUR');
        const yen = await send(app, 'GET', `/groups/${groupId}/rates/JPY?date=2026-11-01`, { token: ann.token });
        expect(yen).toEqual({ status: 200, body: { currency: 'JPY', date: '2026-11-01', rate: '0.0062' } });
        const jpyGroup = await createGroup(ann.token, 'JPY', 'Tokyo');
        const euro = await send(app, 'GET', `/groups/${jpyGroup}/rates/EUR?date=2026-11-01`, { token: ann.token });
        expect(euro).toEqual({ status: 200, body: { currency: 'EUR', date: '2026-11-01', rate: '161.5' } });
      });
    });

    describe('expenses', () => {
      it('keeps an amount in yen as its whole number of yen, and in dinars as its thousandths', async () => {
        const { ann, ben, groupId } = await annAndBen('JPY');
        const yen = await recordExpense(ann.token, groupId, {
          description: 'Ramen',
          date: '2026-11-01',
          amount: 1250,
          splitExactly: [
            { memberId: ann.id, amount: 625 },
            { memberId: ben.id, amount: 625 },
          ],
        });
        expect(await send(app, 'GET', `/expenses/${yen}`, { token: ann.token })).toMatchObject({
          body: { amount: 1250 },
        });
        const dinars = await createGroup(ann.token, 'KWD', 'Kuwait');
        const kuwaiti = await recordExpense(ann.token, dinars, {
          description: 'Dinner',
          date: '2026-11-01',
          amount: 1250,
          splitBetween: [ann.id],
        });
        expect(await send(app, 'GET', `/expenses/${kuwaiti}`, { token: ann.token })).toMatchObject({
          body: { amount: 1250, shares: [{ memberId: ann.id, amount: 1250 }] },
        });
      });

      it('converts 1250 euros into 2019 yen at 161.5, in a yen group', async () => {
        const { ann, ben, groupId } = await annAndBen('JPY');
        const id = await recordExpense(ben.token, groupId, {
          description: 'Ramen',
          date: '2026-11-01',
          original: { currency: 'EUR', amount: 1250, rate: '161.5' },
          splitExactly: [
            { memberId: ann.id, amount: 1009 },
            { memberId: ben.id, amount: 1010 },
          ],
        });
        const read = await send(app, 'GET', `/expenses/${id}`, { token: ann.token });
        expect(read.body).toMatchObject({
          amount: 2019,
          original: { currency: 'EUR', amount: 1250, rate: '161.5' },
        });
        // Ben paid 2019 yen and bears 1010 of it: he is owed 1009 yen, and Ann owes it.
        expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: -1009, [ben.id]: 1009 });
      });

      it('converts 10 000 yen into 6200 hundredths of a euro at 0.0062, in a euro group', async () => {
        const { ann, ben, groupId } = await annAndBen('EUR');
        const id = await recordExpense(ann.token, groupId, {
          description: 'Ramen',
          date: '2026-11-01',
          original: { currency: 'JPY', amount: 10_000, rate: '0.0062' },
          splitBetween: [ann.id, ben.id],
        });
        expect(await send(app, 'GET', `/expenses/${id}`, { token: ann.token })).toMatchObject({
          body: { amount: 6200 },
        });
      });

      it('converts 10 dollars into 3075 thousandths of a dinar at 0.3075, in a dinar group', async () => {
        const { ann, ben, groupId } = await annAndBen('KWD');
        const id = await recordExpense(ann.token, groupId, {
          description: 'Lunch',
          date: '2026-11-01',
          original: { currency: 'USD', amount: 1000, rate: '0.3075' },
          splitBetween: [ann.id, ben.id],
        });
        expect(await send(app, 'GET', `/expenses/${id}`, { token: ann.token })).toMatchObject({
          body: { amount: 3075, original: { currency: 'USD', amount: 1000, rate: '0.3075' } },
        });
      });
    });

    describe('settlements', () => {
      it('settles in cash in yen what is owed, converted from euros at the rate offered on the day', async () => {
        // Ben owes Ann 2019 yen: she paid 4038 yen, split equally.
        const { ann, ben, groupId } = await annAndBen('JPY');
        await recordExpense(ann.token, groupId, {
          description: 'Dinner',
          date: '2026-11-01',
          amount: 4038,
          splitExactly: [
            { memberId: ann.id, amount: 2019 },
            { memberId: ben.id, amount: 2019 },
          ],
        });
        const reply = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
          token: ann.token,
          body: { from: ben.id, original: { currency: 'EUR', amount: 1250 } },
        });
        expect(reply.status).toBe(201);
        const read = await send(app, 'GET', `/settlements/${(reply.body as { id: string }).id}`, { token: ann.token });
        expect(read.body).toMatchObject({
          amount: 2019,
          original: { currency: 'EUR', amount: 1250, rate: '161.5' },
        });
        expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
      });

      it('keeps the provider’s fee, said in yen, in the euros of the group at the rate of the payment', async () => {
        // Ben owes Ann 1500 hundredths of a euro; he pays 2400 yen, 14.88 euros, and the provider keeps 100 yen (0.62 euros).
        const { ann, ben, groupId } = await annAndBen('EUR');
        await send(app, 'PUT', '/accounts/me/payout-account', { token: ann.token, body: { accountId: 'acct_ann' } });
        await recordExpense(ann.token, groupId, {
          description: 'Dinner',
          date: '2026-11-01',
          amount: 3000,
          splitExactly: [
            { memberId: ann.id, amount: 1500 },
            { memberId: ben.id, amount: 1500 },
          ],
        });
        providerFee = 100;
        const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
          token: ben.token,
          body: { to: ann.id, original: { currency: 'JPY', amount: 2400 } },
        });
        expect(asked.status).toBe(201);
        const id = (asked.body as { id: string }).id;
        expect(await send(app, 'GET', `/settlements/${id}`, { token: ben.token })).toMatchObject({
          body: {
            status: 'pending',
            amount: 1488,
            fee: { amount: 62, borneBy: 'payee' },
            original: { currency: 'JPY', amount: 2400, rate: '0.0062' },
          },
        });
        await paymentSucceeded('pay_1');
        expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 12, [ben.id]: -12 });
      });
    });

    describe('reminders', () => {
      /** Records an expense in which `owing` is what the other member owes `payer`, in `groupId`. */
      async function owes(payer: { id: string; token: string }, other: { id: string }, groupId: string, owing: number) {
        await recordExpense(payer.token, groupId, {
          description: 'Rent',
          date: '2026-11-01',
          amount: owing,
          splitExactly: [
            { memberId: payer.id, amount: 0 },
            { memberId: other.id, amount: owing },
          ],
        });
      }

      /** Runs the reminders at the start, then a period later, as the background job does. */
      async function sweepTwice(): Promise<void> {
        await app.runJobs();
        now += WEEK_MS;
        await app.runJobs();
      }

      it('reminds a member who owes more than 20 yen, and not one who owes 20 yen', async () => {
        const { ann, ben, groupId } = await annAndBen('JPY');
        await owes(ann, ben, groupId, 20);
        await sweepTwice();
        expect(await remindersOf(ben.token)).toEqual([]);

        await owes(ann, ben, groupId, 1); // 21 yen owed
        await sweepTwice();
        expect(await remindersOf(ben.token)).toEqual([
          expect.objectContaining({ kind: 'reminder', groupId, amount: 21 }),
        ]);
      });

      it('reminds a member who owes more than 20 000 thousandths of a dinar, and not one who owes 20 000', async () => {
        const { ann, ben, groupId } = await annAndBen('KWD');
        await owes(ann, ben, groupId, 20_000);
        await sweepTwice();
        expect(await remindersOf(ben.token)).toEqual([]);

        await owes(ann, ben, groupId, 1); // 20 001 owed
        await sweepTwice();
        expect(await remindersOf(ben.token)).toEqual([expect.objectContaining({ amount: 20_001 })]);
      });
    });
  });
});
