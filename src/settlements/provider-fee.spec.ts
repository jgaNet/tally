import { createHmac } from 'node:crypto';
import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeProvider,
  joinThroughInvitation,
  send,
  setPayoutAccount,
  signedUpAccount,
  startFakeProvider,
  temporaryDatabaseUrl,
} from '../test-support';

const SECRET = 'shared-secret';

describe('who bears the provider’s fee', () => {
  let app: Application;
  let databaseUrl: string;
  let provider: FakeProvider;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    provider = await startFakeProvider();
    app = await createApplication({
      databaseUrl,
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 300,
      adminEmails: 'boss@example.com',
    });
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
  });

  let counter = 0;
  /** The provider's signed webhook saying `paymentId` is `status`. */
  function webhookFor(paymentId: string, status: string) {
    counter += 1;
    const body = `{ "id": "wh-${counter}", "paymentId": "${paymentId}", "status": "${status}", "at": "2026-11-17T10:00:00Z" }`;
    const signature = createHmac('sha256', SECRET).update(body).digest('hex');
    return app.server.inject({
      method: 'POST',
      url: '/v1/provider/webhooks',
      headers: { 'content-type': 'application/json', 'provider-signature': signature },
      payload: body,
    });
  }

  /** The provider's id of the payment made for the settlement `settlementId`. */
  function providerPaymentOf(settlementId: string): string {
    const payment = provider.payments.find(entry => entry.reference === settlementId);
    if (payment === undefined) {
      throw new Error(`no payment was made for ${settlementId}`);
    }
    return payment.id;
  }

  async function createdGroup(token: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function setPolicy(token: string, groupId: string, borneBy: string): Promise<void> {
    const response = await send(app, 'PUT', `/groups/${groupId}/fee-policy`, { token, payload: { borneBy } });
    expect(response.statusCode).toBe(204);
  }

  async function balanceOf(token: string, groupId: string, memberId: string): Promise<number> {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>().find(entry => entry.memberId === memberId)!.balance;
  }

  /**
   * Ada owns a group with Grace in it. Grace paid 1000 split between Ada and Grace, so Ada owes Grace 500.
   * Grace has a payout account at the provider.
   */
  async function adaOwesGrace() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await setPayoutAccount(app, grace.token, 'acct-grace');
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: grace.token,
      payload: { description: 'Dinner', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(expense.statusCode).toBe(201);
    return { ada, grace, groupId };
  }

  /** Ada pays Grace `amount` through the provider; the settlement's id, once the provider has answered. */
  async function adaPaysGrace(ada: { token: string }, grace: { id: string }, groupId: string, amount: number) {
    const response = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: ada.token,
      payload: { to: grace.id, amount },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function paidThroughProvider(
    ada: { token: string; id: string },
    grace: { id: string; token: string },
    groupId: string,
    amount: number,
  ) {
    const id = await adaPaysGrace(ada, grace, groupId, amount);
    expect((await webhookFor(providerPaymentOf(id), 'succeeded')).statusCode).toBe(204);
    return id;
  }

  describe('asking for a payment', () => {
    it.each([
      ['no fee', undefined],
      ['a fee that is not a whole number', 1.5],
      ['a negative fee', -1],
      ['a fee that is not a number', '31'],
      ['a fee equal to the amount', 300],
      ['a fee more than the amount', 301],
    ])('refuses a payment the provider answers with %s, and keeps nothing', async (_, fee) => {
      const { ada, grace, groupId } = await adaOwesGrace();
      provider.fee = fee;
      const response = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: ada.token,
        payload: { to: grace.id, amount: 300 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ type: 'PaymentNotStarted' });
      const settlements = await send(app, 'GET', `/groups/${groupId}/settlements`, { token: ada.token });
      expect(settlements.json()).toEqual([]);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
    });

    it('answers the fee the provider said and who bears it, with the settlement', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      provider.fee = 31;
      const id = await adaPaysGrace(ada, grace, groupId, 300);
      const settlement = await send(app, 'GET', `/settlements/${id}`, { token: ada.token });
      expect(settlement.json()).toMatchObject({ amount: 300, fee: { amount: 31, borneBy: 'payee' } });
    });
  });

  describe('what a payment settles', () => {
    it('settles its whole amount when the payee bears the fee, the default', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      provider.fee = 31;
      const id = await adaPaysGrace(ada, grace, groupId, 300);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);

      expect((await webhookFor(providerPaymentOf(id), 'succeeded')).statusCode).toBe(204);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-200);
      expect(await balanceOf(ada.token, groupId, grace.id)).toBe(200);
      const audit = await send(app, 'GET', `/groups/${groupId}/audit`, { token: ada.token });
      expect(audit.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ action: 'settlement-paid', subjectId: id, amount: 300 })]),
      );
    });

    it('settles its amount less the fee when the payer bears it, and the payer still owes the fee', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      await setPolicy(ada.token, groupId, 'payer');
      provider.fee = 31;
      const id = await paidThroughProvider(ada, grace, groupId, 300);

      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-231);
      expect(await balanceOf(ada.token, groupId, grace.id)).toBe(231);
      const statement = await send(app, 'GET', `/groups/${groupId}/members/${ada.id}/statement`, { token: ada.token });
      expect(statement.json()).toMatchObject({
        balance: -231,
        entries: expect.arrayContaining([expect.objectContaining({ kind: 'settlement', paid: 269, share: 0 })]),
      });
      const audit = await send(app, 'GET', `/groups/${groupId}/audit`, { token: ada.token });
      expect(audit.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ action: 'settlement-paid', subjectId: id, amount: 269 })]),
      );
    });

    it.each([
      [30, 285],
      [31, 285],
      [33, 284],
    ])('settles its amount less half the fee when shared: a fee of %i settles %i of 300', async (fee, settles) => {
      const { ada, grace, groupId } = await adaOwesGrace();
      await setPolicy(ada.token, groupId, 'shared');
      provider.fee = fee;
      await paidThroughProvider(ada, grace, groupId, 300);

      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500 + settles);
      expect(await balanceOf(ada.token, groupId, grace.id)).toBe(500 - settles);
    });

    it('counts what a payment waiting at the provider settles as what is still owed', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      await setPolicy(ada.token, groupId, 'payer');
      provider.fee = 31;
      await adaPaysGrace(ada, grace, groupId, 300);

      // Ada still owes 500 - 269 = 231, what the waiting payment settles counted.
      const tooMuch = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: ada.token,
        payload: { to: grace.id, amount: 232 },
      });
      expect(tooMuch.statusCode).toBe(409);
      expect(tooMuch.json()).toMatchObject({ type: 'MoreThanIsOwed' });
    });

    it('keeps the fee and who bore it as they were when the payment was asked for', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      await setPolicy(ada.token, groupId, 'payer');
      provider.fee = 31;
      const id = await adaPaysGrace(ada, grace, groupId, 300);

      await setPolicy(ada.token, groupId, 'payee');
      expect((await webhookFor(providerPaymentOf(id), 'succeeded')).statusCode).toBe(204);

      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-231);
      const settlement = await send(app, 'GET', `/settlements/${id}`, { token: ada.token });
      expect(settlement.json()).toMatchObject({ amount: 300, fee: { amount: 31, borneBy: 'payer' } });
    });

    it('gives back what it settled when it is refunded', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      await setPolicy(ada.token, groupId, 'payer');
      provider.fee = 31;
      const id = await paidThroughProvider(ada, grace, groupId, 300);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-231);

      const refund = await send(app, 'POST', `/settlements/${id}/refund`, { token: grace.token });
      expect(refund.statusCode).toBe(204);
      expect((await webhookFor(providerPaymentOf(id), 'refunded')).statusCode).toBe(204);

      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
      const audit = await send(app, 'GET', `/groups/${groupId}/audit`, { token: ada.token });
      expect(audit.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'settlement-refunded', subjectId: id, amount: 269 }),
        ]),
      );
    });

    it('is audited, once an administrator decides it was paid, as what it settles', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      await setPolicy(ada.token, groupId, 'payer');
      provider.fee = 31;
      const id = await paidThroughProvider(ada, grace, groupId, 300);
      expect((await send(app, 'POST', `/settlements/${id}/contest`, { token: grace.token })).statusCode).toBe(204);
      const boss = await signedUpAccount(app, { email: 'boss@example.com', name: 'Boss' });
      const decision = await send(app, 'POST', `/admin/settlements/${id}/decision`, {
        token: boss.token,
        payload: { paid: true },
      });
      expect(decision.statusCode).toBe(204);

      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-231);
      const audit = await send(app, 'GET', `/groups/${groupId}/audit`, { token: ada.token });
      // The payment's success, its contest and the decision each count what it settles: 269, not 300.
      expect(audit.json<{ subjectId: string; amount: number }[]>().filter(entry => entry.subjectId === id)).toEqual([
        expect.objectContaining({ amount: 269 }),
        expect.objectContaining({ amount: 269 }),
        expect.objectContaining({ amount: 269 }),
      ]);
    });

    it('reads no fee of a settlement in cash, which has none', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const cash = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 100 },
      });
      expect(cash.statusCode).toBe(201);
      const settlement = await send(app, 'GET', `/settlements/${cash.json<{ id: string }>().id}`, {
        token: ada.token,
      });
      expect(settlement.json()).not.toHaveProperty('fee');
    });
  });
});
