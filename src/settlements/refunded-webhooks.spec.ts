import { createHmac } from 'node:crypto';
import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeProvider,
  joinThroughInvitation,
  send,
  signedUpAccount,
  startFakeProvider,
  temporaryDatabasePath,
} from '../test-support';

const SECRET = 'shared-secret';

describe('the provider’s refunded webhooks', () => {
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

  async function read(token: string, id: string) {
    return send(app, 'GET', `/settlements/${id}`, { token });
  }

  async function balanceOf(token: string, groupId: string, memberId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    return response.json<{ memberId: string; balance: number }[]>().find(b => b.memberId === memberId)?.balance;
  }

  let scenarios = 0;
  /**
   * Ada owes Grace 500: Grace paid 1000 split between them. Ada asks the provider to pay 300 of it, and
   * the payment is the last one the provider made. The provider has not said how it ended.
   */
  async function adaPays300() {
    scenarios += 1;
    const ada = await signedUpAccount(app, { email: `ada${scenarios}@example.com` });
    const grace = await signedUpAccount(app, { email: `grace${scenarios}@example.com`, name: 'Grace' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: grace.token,
      payload: { description: 'Dinner', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(expense.statusCode).toBe(201);
    const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: ada.token,
      payload: { to: grace.id, amount: 300 },
    });
    expect(asked.statusCode).toBe(201);
    const paymentId = provider.payments[provider.payments.length - 1].id;
    return { ada, grace, groupId, id: asked.json<{ id: string }>().id, paymentId };
  }

  it('makes a payment refunded when the provider says so, even though Tally did not ask: the balances no longer count it', async () => {
    const { ada, grace, groupId, id, paymentId } = await adaPays300();
    expect((await webhook(paymentId, 'succeeded')).statusCode).toBe(204);
    expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-200);
    expect((await webhook(paymentId, 'refunded')).statusCode).toBe(204);
    expect((await read(grace.token, id)).json()).toEqual(expect.objectContaining({ status: 'refunded' }));
    expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
  });

  it('counts a refund once however often the provider repeats it', async () => {
    const { ada, groupId, paymentId } = await adaPays300();
    await webhook(paymentId, 'succeeded');
    expect((await webhook(paymentId, 'refunded')).statusCode).toBe(204);
    expect((await webhook(paymentId, 'refunded')).statusCode).toBe(204);
    expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
  });

  it('lets a refunded that overtakes the success of its payment leave it refunded, never counted', async () => {
    const { ada, grace, groupId, id, paymentId } = await adaPays300();
    expect((await webhook(paymentId, 'refunded')).statusCode).toBe(204);
    expect((await read(grace.token, id)).json().status).toBe('refunded');
    expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
    // The success that comes late changes nothing: the payment has ended as refunded.
    expect((await webhook(paymentId, 'succeeded')).statusCode).toBe(204);
    expect((await read(grace.token, id)).json().status).toBe('refunded');
    expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
  });

  it('changes nothing when a succeeded or a pending arrives after a refunded', async () => {
    const { ada, grace, groupId, id, paymentId } = await adaPays300();
    await webhook(paymentId, 'succeeded');
    await webhook(paymentId, 'refunded');
    expect((await webhook(paymentId, 'succeeded')).statusCode).toBe(204);
    expect((await webhook(paymentId, 'pending')).statusCode).toBe(204);
    expect((await read(grace.token, id)).json().status).toBe('refunded');
    expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
  });

  it('changes nothing about a payment that failed: a failed payment cannot be refunded', async () => {
    const { ada, grace, groupId, id, paymentId } = await adaPays300();
    await webhook(paymentId, 'failed');
    expect((await webhook(paymentId, 'refunded')).statusCode).toBe(204);
    expect((await read(grace.token, id)).json().status).toBe('failed');
    expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
  });

  it('leaves a refunded payment out of the suggested settlements, as what is still owed', async () => {
    const { ada, grace, groupId, paymentId } = await adaPays300();
    await webhook(paymentId, 'succeeded');
    await webhook(paymentId, 'refunded');
    const suggested = await send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: ada.token });
    expect(suggested.json()).toEqual([{ from: ada.id, to: grace.id, amount: 500 }]);
  });

  it('changes nothing about a payment Tally does not know, and is still acknowledged', async () => {
    const { ada, groupId } = await adaPays300();
    expect((await webhook('pay-unknown', 'refunded')).statusCode).toBe(204);
    expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
  });

  it('keeps a refund the provider reports even when a refusal of Tally’s own request arrives after it', async () => {
    // Grace asks for the refund and the provider is slow: the refunded webhook comes while it waits.
    const { grace, id, paymentId } = await adaPays300();
    await webhook(paymentId, 'succeeded');
    provider.refundMode = 'hang';
    const asked = send(app, 'POST', `/settlements/${id}/refund`, { token: grace.token });
    while (provider.refunds.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect((await webhook(paymentId, 'refunded')).statusCode).toBe(204);
    // The provider does not answer in time: the request is refused, but the refund the webhook said
    // happened stands.
    const response = await asked;
    expect(response.statusCode).toBe(409);
    expect(response.json().type).toBe('RefundNotStarted');
    expect((await read(grace.token, id)).json().status).toBe('refunded');
  });
});
