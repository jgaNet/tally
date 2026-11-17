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
  temporaryDatabasePath,
} from '../test-support';

const SECRET = 'shared-secret';

describe('refunding a payment through the provider', () => {
  let app: Application;
  let databasePath: string;
  let provider: FakeProvider;

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    provider = await startFakeProvider();
    app = await createApplication({
      databasePath,
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 300,
    });
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
  });

  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

  let counter = 0;
  /** The provider's signed webhook about `paymentId` saying `status`. */
  function webhook(paymentId: string, status: string) {
    counter += 1;
    const body = `{ "id": "wh-${counter}", "paymentId": "${paymentId}", "status": "${status}", "at": "2026-11-17T10:00:00Z" }`;
    return app.server.inject({
      method: 'POST',
      url: '/v1/provider/webhooks',
      headers: { 'content-type': 'application/json', 'provider-signature': sign(body) },
      payload: body,
    });
  }

  async function createdGroup(token: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function refund(token: string, id: string) {
    return send(app, 'POST', `/settlements/${id}/refund`, { token });
  }

  async function read(token: string, id: string) {
    return send(app, 'GET', `/settlements/${id}`, { token });
  }

  async function balanceOf(token: string, groupId: string, memberId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>().find(b => b.memberId === memberId)?.balance;
  }

  let scenarios = 0;
  /**
   * Ada owes Grace 500: Grace paid 1000 split between them. Grace owns the group, so Ada, a plain member,
   * may leave it. Ada pays `amount` of it through the provider, and the provider says the payment
   * succeeded, so the settlement is paid.
   */
  async function paidThroughProvider(amount = 300) {
    scenarios += 1;
    const ada = await signedUpAccount(app, { email: `ada${scenarios}@example.com` });
    const grace = await signedUpAccount(app, { email: `grace${scenarios}@example.com`, name: 'Grace' });
    const groupId = await createdGroup(grace.token);
    await joinThroughInvitation(app, grace.token, ada.token, groupId);
    await setPayoutAccount(app, grace.token, 'acct-grace');
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: grace.token,
      payload: { description: 'Dinner', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(expense.statusCode).toBe(201);
    const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: ada.token,
      payload: { to: grace.id, amount },
    });
    expect(asked.statusCode).toBe(201);
    const id = asked.json<{ id: string }>().id;
    const paymentId = provider.payments[provider.payments.length - 1].id;
    expect((await webhook(paymentId, 'succeeded')).statusCode).toBe(204);
    return { ada, grace, groupId, id, paymentId };
  }

  describe('asking the provider', () => {
    it('is done by the payee: the provider is asked to refund the payment, referenced by the settlement, and the settlement is refunding', async () => {
      const { ada, grace, groupId, id, paymentId } = await paidThroughProvider();
      const response = await refund(grace.token, id);
      expect(response.statusCode).toBe(204);
      expect(provider.refunds).toEqual([{ paymentId, reference: id }]);
      expect((await read(grace.token, id)).json()).toEqual(
        expect.objectContaining({ id, status: 'refunding', method: 'provider', amount: 300 }),
      );
      // The provider has not refunded the money yet, so the balances still count the settlement as paid.
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-200);
    });

    it('keeps a refunding settlement counted, so a member with a refund waiting cannot leave the group', async () => {
      const { ada, grace, groupId, id } = await paidThroughProvider(500);
      // Ada's balance is 0 now that she has paid all she owed.
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(0);
      expect((await refund(grace.token, id)).statusCode).toBe(204);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(0);
      const leave = await send(app, 'POST', `/groups/${groupId}/leave`, { token: ada.token });
      expect(leave.statusCode).toBe(409);
      expect(leave.json().type).toBe('PaymentPending');
    });

    it('is refused to the payer with 403, and asks the provider nothing', async () => {
      const { ada, groupId, id } = await paidThroughProvider();
      const response = await refund(ada.token, id);
      expect(response.statusCode).toBe(403);
      expect(response.json().type).toBe('NotPayee');
      expect(provider.refunds).toHaveLength(0);
      expect((await read(ada.token, id)).json().status).toBe('paid');
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-200);
    });

    it('answers 401 to a request with no token, and 404 to someone outside the group, as for a settlement that is not there', async () => {
      const { grace, id } = await paidThroughProvider();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      expect((await send(app, 'POST', `/settlements/${id}/refund`)).statusCode).toBe(401);
      const outsider = await refund(eve.token, id);
      const missing = await refund(eve.token, 'no-such-settlement');
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json()).toEqual(missing.json());
      expect(provider.refunds).toHaveLength(0);
      expect((await read(grace.token, id)).json().status).toBe('paid');
    });

    it('is refused with 409 for a cash settlement, which is never refunded through Tally, and asks nothing', async () => {
      const { ada, grace, groupId } = await paidThroughProvider();
      const cash = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 100 },
      });
      expect(cash.statusCode).toBe(201);
      const id = cash.json<{ id: string }>().id;
      const response = await refund(grace.token, id);
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('NotRefundable');
      expect(provider.refunds).toHaveLength(0);
      expect((await read(grace.token, id)).json().status).toBe('paid');
    });

    it('is refused with 409 for a payment still waiting at the provider, which is not paid yet', async () => {
      const { ada, grace, groupId } = await paidThroughProvider();
      const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: ada.token,
        payload: { to: grace.id, amount: 200 },
      });
      expect(asked.statusCode).toBe(201);
      const id = asked.json<{ id: string }>().id;
      const response = await refund(grace.token, id);
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('NotRefundable');
      expect(provider.refunds).toHaveLength(0);
    });

    it('is refused with 409 when it is asked again while refunding, or after it is refunded, so the provider is asked once', async () => {
      const { grace, id, paymentId } = await paidThroughProvider();
      expect((await refund(grace.token, id)).statusCode).toBe(204);
      const again = await refund(grace.token, id);
      expect(again.statusCode).toBe(409);
      expect(again.json().type).toBe('NotRefundable');
      expect(provider.refunds).toEqual([{ paymentId, reference: id }]);

      expect((await webhook(paymentId, 'refunded')).statusCode).toBe(204);
      const afterRefund = await refund(grace.token, id);
      expect(afterRefund.statusCode).toBe(409);
      expect(afterRefund.json().type).toBe('NotRefundable');
      expect(provider.refunds).toHaveLength(1);
    });

    it.each([
      ['answers with something other than 201', 'refuse'],
      ['answers 201 without an id', 'malformed'],
      ['does not answer in time', 'hang'],
    ] as const)('is refused with 409 when the provider %s, and nothing changes', async (_, mode) => {
      const { ada, grace, groupId, id } = await paidThroughProvider();
      provider.refundMode = mode;
      const response = await refund(grace.token, id);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ type: 'RefundNotStarted', message: expect.any(String) });
      expect((await read(grace.token, id)).json().status).toBe('paid');
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-200);

      // Nothing is held: the provider can be asked again, and it refunds.
      provider.refundMode = 'accept';
      expect((await refund(grace.token, id)).statusCode).toBe(204);
      expect((await read(grace.token, id)).json().status).toBe('refunding');
    });

    it('is refused with 409 when a member of the settlement has left, as the balances must still add up to 0', async () => {
      const { ada, grace, groupId, id } = await paidThroughProvider(500);
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ada.token })).statusCode).toBe(204);
      const response = await refund(grace.token, id);
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('MemberHasLeft');
      expect(provider.refunds).toHaveLength(0);
      expect((await read(grace.token, id)).json().status).toBe('paid');
    });

    it('is refused with 409 when no provider is set up on this server, and changes nothing', async () => {
      const { ada, grace, groupId, id } = await paidThroughProvider();
      await app.stop();
      app = await createApplication({ databasePath, providerWebhookSecret: SECRET });
      const response = await refund(grace.token, id);
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('ProviderNotConfigured');
      expect((await read(grace.token, id)).json().status).toBe('paid');
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-200);
    });
  });

  describe('the balances once the provider says so', () => {
    it('refunds a paid settlement through the provider, and the balances go back once the provider says it is refunded', async () => {
      const { ada, grace, groupId, id, paymentId } = await paidThroughProvider();
      expect((await refund(grace.token, id)).statusCode).toBe(204);
      expect((await webhook(paymentId, 'refunded')).statusCode).toBe(204);
      expect((await read(grace.token, id)).json()).toEqual(expect.objectContaining({ status: 'refunded' }));
      // As before the payment: Ada owes the 500 again, and the balances add up to 0.
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
      const balances = await send(app, 'GET', `/groups/${groupId}/balances`, { token: grace.token });
      expect(balances.json().reduce((sum: number, b: { balance: number }) => sum + b.balance, 0)).toBe(0);
    });

    it('lets the payer pay again what the refund gave back, through the provider', async () => {
      const { ada, grace, groupId, id, paymentId } = await paidThroughProvider();
      await refund(grace.token, id);
      await webhook(paymentId, 'refunded');
      const again = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: ada.token,
        payload: { to: grace.id, amount: 500 },
      });
      expect(again.statusCode).toBe(201);
    });

    it('keeps the refund when the application stops and starts again', async () => {
      const { ada, grace, groupId, id, paymentId } = await paidThroughProvider();
      await refund(grace.token, id);
      await webhook(paymentId, 'refunded');
      await app.stop();
      app = await createApplication({ databasePath, providerUrl: provider.url, providerWebhookSecret: SECRET });
      expect((await read(grace.token, id)).json().status).toBe('refunded');
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
    });
  });
});
