import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Application, createApplication } from './app';
import { type Database, openDatabase } from './database';
import { ensureDatabase, send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

const SECRET = 'shared with the provider';

/** The provider's id of Ann's payout account, which the fixture sets; the fake provider knows every account. */
const ANN_PAYOUT = 'acct_ann';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The webhook signature the provider puts on a body: HMAC-SHA256, in lowercase hexadecimal. */
function signed(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

/** One request the fake provider was sent: its path and its body, when it has one. */
interface ProviderCall {
  readonly path: string | undefined;
  readonly body: unknown;
}

describe('settling up in another currency', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: Database;
  let provider: Server;
  let providerUrl: string;
  let providerCalls: ProviderCall[];
  /** The fee the fake provider keeps in each payment it creates, in the payment's currency. */
  let providerFee: number;
  /** How many payments the fake provider has created, so the first is `pay_1`. */
  let payments: number;
  let rates: Server;
  let ratesUrl: string;
  /** The paths (with their queries) the fake rates service was asked. */
  let rateCalls: string[];
  /** What the fake rates service answers: by default, a rate of 0.95 from francs to euros. */
  let rateAnswer: { status: number; body?: unknown };

  beforeEach(async () => {
    directory = testDirectory();
    providerCalls = [];
    providerFee = 0;
    payments = 0;
    rateCalls = [];
    rateAnswer = { status: 200, body: { rate: '0.95' } };
    provider = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => (raw += chunk));
      request.on('end', () => {
        const json = { 'content-type': 'application/json' };
        const path = request.url ?? '';
        const body: unknown = raw === '' ? undefined : JSON.parse(raw);
        providerCalls.push({ path, body });
        if (path.startsWith('/accounts/')) {
          response.writeHead(200, json);
          response.end(JSON.stringify({ id: decodeURIComponent(path.slice('/accounts/'.length)) }));
          return;
        }
        if (path.endsWith('/refunds')) {
          response.writeHead(201, json);
          response.end(JSON.stringify({ id: 're_1' }));
          return;
        }
        const n = ++payments;
        response.writeHead(201, json);
        response.end(JSON.stringify({ id: `pay_${n}`, payUrl: `https://pay.example.org/${n}`, fee: providerFee }));
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    rates = createServer((request, response) => {
      rateCalls.push(request.url ?? '');
      response.writeHead(rateAnswer.status, { 'content-type': 'application/json' });
      response.end(rateAnswer.body === undefined ? '' : JSON.stringify(rateAnswer.body));
    });
    await new Promise<void>(resolve => rates.listen(0, '127.0.0.1', resolve));
    ratesUrl = `http://127.0.0.1:${(rates.address() as AddressInfo).port}`;
    await ensureDatabase(directory.databaseUrl);
    app = await createApplication({
      databaseUrl: directory.databaseUrl,
      providerUrl,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 200,
      ratesUrl,
      ratesTimeoutMs: 200,
    });
    await app.start(0);
    // A second connection to the same file, to count what was stored.
    db = await openDatabase({ url: directory.databaseUrl });
  });

  afterEach(async () => {
    await db.close();
    await app.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    provider.closeAllConnections();
    await new Promise<void>(resolve => rates.close(() => resolve()));
    rates.closeAllConnections();
    await directory.remove();
  });

  /**
   * A euro group of Ann's, with Ben, in which Ann paid `amount` split equally: Ben owes Ann half of it. Ann has a payout
   * account. The calls made so far are forgotten.
   */
  async function annAndBen(amount = 3000) {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const created = await send(app, 'POST', '/groups', { token: ann.token, body: { name: 'Trip', currency: 'EUR' } });
    if (created.status !== 201) throw new Error(`create answered ${created.status}`);
    const groupId = (created.body as { id: string }).id;
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ann.token });
    const accepted = await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: ben.token,
    });
    if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount, date: utcDay(0), splitBetween: [ann.id, ben.id] },
    });
    if (expense.status !== 201) throw new Error(`record answered ${expense.status}`);
    const payout = await send(app, 'PUT', '/accounts/me/payout-account', {
      token: ann.token,
      body: { accountId: ANN_PAYOUT },
    });
    if (payout.status !== 204) throw new Error(`payout account answered ${payout.status}`);
    providerCalls.length = 0;
    rateCalls.length = 0;
    return { ann, ben, groupId };
  }

  /** Records a cash settlement as `payeeToken`'s account, with `body`. */
  async function settleInCash(payeeToken: string, groupId: string, body: unknown) {
    return send(app, 'POST', `/groups/${groupId}/settlements/cash`, { token: payeeToken, body });
  }

  /** Asks the provider for a payment as `payerToken`'s account, with `body`. */
  async function askProvider(payerToken: string, groupId: string, body: unknown) {
    return send(app, 'POST', `/groups/${groupId}/settlements/provider`, { token: payerToken, body });
  }

  /** The balances of `groupId`, read as `token`'s account, as a map from member to balance. */
  async function balancesAs(token: string, groupId: string): Promise<Record<string, number>> {
    const reply = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    const rows = reply.body as { memberId: string; balance: number }[];
    return Object.fromEntries(rows.map(row => [row.memberId, row.balance]));
  }

  /** The settlement with `id`, read as `token`'s account. */
  async function readSettlement(token: string, id: string) {
    return send(app, 'GET', `/settlements/${id}`, { token });
  }

  /** The audit of `groupId`, read as `token`'s account. */
  async function auditAs(
    token: string,
    groupId: string,
  ): Promise<{ action: string; subjectId: string; amount: number }[]> {
    const reply = await send(app, 'GET', `/groups/${groupId}/audit`, { token });
    return reply.body as { action: string; subjectId: string; amount: number }[];
  }

  /** The provider sends `status` about `paymentId`, signed: the webhook is acknowledged, and whatever it changes is changed. */
  async function webhook(paymentId: string, status: string): Promise<void> {
    const body = JSON.stringify({ id: `evt_${paymentId}_${status}`, paymentId, status, at: new Date().toISOString() });
    await fetch(`${app.address}/${app.apiPrefix}/provider/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'provider-signature': signed(body) },
      body,
    });
  }

  describe('in cash', () => {
    it('settles at the rate offered on the day, and reads the original amount and the rate with the settlement', async () => {
      const { ann, ben, groupId } = await annAndBen();
      // Ben owes 1500, and pays 1500 francs: at 0.95, the settlement is 1425 in euros.
      const recorded = await settleInCash(ann.token, groupId, {
        from: ben.id,
        original: { currency: 'CHF', amount: 1500 },
      });
      expect(recorded.status).toBe(201);
      const id = (recorded.body as { id: string }).id;
      expect(rateCalls).toEqual([`/rates/CHF/EUR?date=${utcDay(0)}`]);
      const read = await readSettlement(ben.token, id);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        id,
        groupId,
        from: ben.id,
        to: ann.id,
        amount: 1425,
        method: 'cash',
        status: 'paid',
        original: { currency: 'CHF', amount: 1500, rate: '0.95' },
      });
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 75, [ben.id]: -75 });
      expect(await auditAs(ann.token, groupId)).toEqual(
        expect.arrayContaining([expect.objectContaining({ action: 'settlement-paid', subjectId: id, amount: 1425 })]),
      );
    });

    it('keeps the rate it was decided at: a rate that changes later changes neither the settlement nor the balances', async () => {
      const { ann, ben, groupId } = await annAndBen();
      const id = (
        (await settleInCash(ann.token, groupId, { from: ben.id, original: { currency: 'CHF', amount: 1500 } }))
          .body as { id: string }
      ).id;
      rateAnswer = { status: 200, body: { rate: '0.5' } };
      const read = await readSettlement(ben.token, id);
      expect(read.body).toMatchObject({ amount: 1425, original: { currency: 'CHF', amount: 1500, rate: '0.95' } });
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 75, [ben.id]: -75 });
    });

    it('takes no rate from the payer: the rate is the rates service’s', async () => {
      const { ann, ben, groupId } = await annAndBen();
      const recorded = await settleInCash(ann.token, groupId, {
        from: ben.id,
        original: { currency: 'CHF', amount: 1500, rate: '0.5' },
      });
      expect(recorded.status).toBe(201);
      const read = await readSettlement(ben.token, (recorded.body as { id: string }).id);
      expect(read.body).toMatchObject({ amount: 1425, original: { rate: '0.95' } });
    });

    it('keeps a settlement in the group’s currency without an original', async () => {
      const { ann, ben, groupId } = await annAndBen();
      const recorded = await settleInCash(ann.token, groupId, { from: ben.id, amount: 1500 });
      const read = await readSettlement(ben.token, (recorded.body as { id: string }).id);
      expect(read.body).toMatchObject({ amount: 1500 });
      expect(read.body).not.toHaveProperty('original');
    });

    it('is refused when no rate is offered, and keeps nothing', async () => {
      const { ann, ben, groupId } = await annAndBen();
      for (const answer of [
        { status: 404, body: { error: 'Unknown' } },
        { status: 200, body: { rate: 'not a rate' } },
      ]) {
        rateAnswer = answer;
        const refused = await settleInCash(ann.token, groupId, {
          from: ben.id,
          original: { currency: 'CHF', amount: 1500 },
        });
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({ error: 'RateIsNotOffered' });
      }
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
      expect((await send(app, 'GET', `/groups/${groupId}/settlements`, { token: ann.token })).body).toEqual([]);
    });

    it('is refused as more than is owed once the amount is converted, and keeps nothing', async () => {
      const { ann, ben, groupId } = await annAndBen();
      // 1600 francs at 0.95 is 1520 euros, more than the 1500 Ben owes.
      const tooMuch = await settleInCash(ann.token, groupId, {
        from: ben.id,
        original: { currency: 'CHF', amount: 1600 },
      });
      expect(tooMuch.status).toBe(409);
      expect(tooMuch.body).toMatchObject({ error: 'AmountExceedsBalance' });
      expect(await db.prepare('SELECT COUNT(*) AS n FROM settlements').get()).toEqual({ n: 0 });
    });

    it('refuses a currency that is the group’s own, or not one of Tally’s, and an original amount out of range', async () => {
      const { ann, ben, groupId } = await annAndBen();
      const cases: [{ currency: string; amount: number }, string][] = [
        [{ currency: 'EUR', amount: 100 }, 'CurrencyIsTheGroupsCurrency'],
        [{ currency: 'SEK', amount: 100 }, 'CurrencyIsUnsupported'],
        [{ currency: 'CHF', amount: 0 }, 'OriginalAmountIsInvalid'],
        [{ currency: 'CHF', amount: 100_000_001 }, 'OriginalAmountIsInvalid'],
        [{ currency: 'CHF', amount: 1.5 }, 'OriginalAmountIsInvalid'],
      ];
      for (const [original, error] of cases) {
        const refused = await settleInCash(ann.token, groupId, { from: ben.id, original });
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({ error });
      }
      expect(await db.prepare('SELECT COUNT(*) AS n FROM settlements').get()).toEqual({ n: 0 });
    });

    it('refuses a body that names neither amount nor original, or both, or an original without its amount', async () => {
      const { ann, ben, groupId } = await annAndBen();
      const shapes = [
        { from: ben.id },
        { from: ben.id, amount: 100, original: { currency: 'CHF', amount: 100 } },
        { from: ben.id, original: { currency: 'CHF' } },
      ];
      for (const body of shapes) {
        expect((await settleInCash(ann.token, groupId, body)).status).toBe(400);
      }
    });
  });

  describe('through the provider', () => {
    it('asks the provider for the payment in its currency and amount, and keeps the fee converted at the rate', async () => {
      // The provider keeps 30 francs; at 0.95 that is 28.5, which rounds half up to 29 euros.
      providerFee = 30;
      const { ann, ben, groupId } = await annAndBen();
      const asked = await askProvider(ben.token, groupId, { to: ann.id, original: { currency: 'CHF', amount: 1500 } });
      expect(asked.status).toBe(201);
      const id = (asked.body as { id: string }).id;
      expect(providerCalls).toEqual([
        { path: '/payments', body: { reference: id, amount: 1500, currency: 'CHF', payee: ANN_PAYOUT } },
      ]);
      expect((await readSettlement(ben.token, id)).body).toMatchObject({
        status: 'pending',
        amount: 1425,
        payUrl: 'https://pay.example.org/1',
        fee: { amount: 29, borneBy: 'payee' },
        original: { currency: 'CHF', amount: 1500, rate: '0.95' },
      });
      // Pending, the settlement is not counted yet.
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
      await webhook('pay_1', 'succeeded');
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 75, [ben.id]: -75 });
    });

    it('takes the payer’s part of the converted fee, when the payer bears the fee', async () => {
      providerFee = 30;
      const { ann, ben, groupId } = await annAndBen();
      const policy = await send(app, 'PUT', `/groups/${groupId}/fee-policy`, {
        token: ann.token,
        body: { borneBy: 'payer' },
      });
      expect(policy.status).toBe(204);
      const id = (
        (await askProvider(ben.token, groupId, { to: ann.id, original: { currency: 'CHF', amount: 1500 } })).body as {
          id: string;
        }
      ).id;
      expect((await readSettlement(ben.token, id)).body).toMatchObject({
        amount: 1425,
        fee: { amount: 29, borneBy: 'payer' },
      });
      await webhook('pay_1', 'succeeded');
      // The payer settles 1425 less the 29 it bears: 1396 of its 1500.
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 104, [ben.id]: -104 });
    });

    it('counts a payment that lands later at the amount decided then, and so does its refund', async () => {
      const { ann, ben, groupId } = await annAndBen();
      const id = (
        (await askProvider(ben.token, groupId, { to: ann.id, original: { currency: 'CHF', amount: 1500 } })).body as {
          id: string;
        }
      ).id;
      // The rate moves before the payment lands.
      rateAnswer = { status: 200, body: { rate: '0.5' } };
      await webhook('pay_1', 'succeeded');
      expect((await readSettlement(ben.token, id)).body).toMatchObject({
        status: 'paid',
        amount: 1425,
        original: { rate: '0.95' },
      });
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 75, [ben.id]: -75 });
      expect((await send(app, 'POST', `/settlements/${id}/refund`, { token: ann.token })).status).toBe(204);
      await webhook('pay_1', 'refunded');
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
      expect(await auditAs(ann.token, groupId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'settlement-paid', subjectId: id, amount: 1425 }),
          expect.objectContaining({ action: 'settlement-refunded', subjectId: id, amount: 1425 }),
        ]),
      );
    });

    it('is refused when no rate is offered, and the provider is not asked', async () => {
      const { ann, ben, groupId } = await annAndBen();
      rateAnswer = { status: 404, body: { error: 'Unknown' } };
      const refused = await askProvider(ben.token, groupId, {
        to: ann.id,
        original: { currency: 'CHF', amount: 1500 },
      });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ error: 'RateIsNotOffered' });
      expect(providerCalls).toEqual([]);
      expect((await send(app, 'GET', `/groups/${groupId}/settlements`, { token: ben.token })).body).toEqual([]);
    });

    it('refuses a fee that is no less than the amount once converted, and keeps nothing', async () => {
      // Ben owes 100. Two francs at 0.5 are 1 euro; the provider keeps 1 franc, which is 1 euro too.
      rateAnswer = { status: 200, body: { rate: '0.5' } };
      providerFee = 1;
      const { ann, ben, groupId } = await annAndBen(200);
      const refused = await askProvider(ben.token, groupId, { to: ann.id, original: { currency: 'CHF', amount: 2 } });
      expect(refused.status).toBe(424);
      expect(refused.body).toMatchObject({ error: 'FeeIsNotLessThanAmount' });
      expect((await send(app, 'GET', `/groups/${groupId}/settlements`, { token: ben.token })).body).toEqual([]);
    });

    it('refuses a body that names neither amount nor original, or both', async () => {
      const { ann, ben, groupId } = await annAndBen();
      const shapes = [{ to: ann.id }, { to: ann.id, amount: 100, original: { currency: 'CHF', amount: 100 } }];
      for (const body of shapes) {
        expect((await askProvider(ben.token, groupId, body)).status).toBe(400);
      }
      expect(providerCalls).toEqual([]);
    });
  });
});
