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

describe('the provider’s webhooks', () => {
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

  const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');

  /** Sends the webhook as the provider does: the body exactly as given, and its signature when there is one. */
  function deliver(body: string, signature?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature !== undefined) {
      headers['provider-signature'] = signature;
    }
    return app.server.inject({ method: 'POST', url: '/v1/provider/webhooks', headers, payload: body });
  }

  let counter = 0;
  let scenarios = 0;
  /** A webhook about `paymentId` saying `status`, signed with `secret`. Its body has spaces, so re-encoding it would change it. */
  function webhookFor(paymentId: string, status: string, secret = SECRET) {
    counter += 1;
    const body = `{ "id": "wh-${counter}", "paymentId": "${paymentId}", "status": "${status}", "at": "2026-11-17T10:00:00Z" }`;
    return deliver(body, sign(body, secret));
  }

  async function createdGroup(token: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
    return response.json<{ id: string }>().id;
  }

  /**
   * Ada owes Grace 500 (Grace paid 1000 split between them). Ada then asks the provider to pay 300 of it,
   * and the payment is the last one the provider made.
   */
  async function adaPaysThroughProvider() {
    scenarios += 1;
    const ada = await signedUpAccount(app, { email: `ada${scenarios}@example.com` });
    const grace = await signedUpAccount(app, { email: `grace${scenarios}@example.com`, name: 'Grace' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await setPayoutAccount(app, grace.token, 'acct-grace');
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
    const payment = provider.payments[provider.payments.length - 1];
    return { ada, grace, groupId, id: asked.json<{ id: string }>().id, paymentId: payment.id, payUrl: payment.payUrl };
  }

  async function read(token: string, id: string) {
    return send(app, 'GET', `/settlements/${id}`, { token });
  }

  async function balanceOfAda(token: string, groupId: string, adaId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    return response.json<{ memberId: string; balance: number }[]>().find(b => b.memberId === adaId)?.balance;
  }

  describe('the signature', () => {
    it('refuses a webhook with no signature with 401, and changes nothing', async () => {
      const { ada, grace, id, paymentId, groupId } = await adaPaysThroughProvider();
      const body = JSON.stringify({ id: 'wh-x', paymentId, status: 'succeeded', at: '2026-11-17T10:00:00Z' });
      const response = await deliver(body);
      expect(response.statusCode).toBe(401);
      expect(response.json().type).toBe('InvalidSignature');
      expect((await read(grace.token, id)).json().status).toBe('pending');
      expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(-500);
    });

    it('refuses a webhook signed with another secret, or a body changed after it was signed, with 401', async () => {
      const { ada, grace, id, paymentId } = await adaPaysThroughProvider();
      const body = `{ "id": "wh-y", "paymentId": "${paymentId}", "status": "succeeded", "at": "2026-11-17T10:00:00Z" }`;
      expect((await deliver(body, sign(body, 'someone-else'))).statusCode).toBe(401);
      const changed = body.replace('succeeded', 'failed');
      expect((await deliver(changed, sign(body))).statusCode).toBe(401);
      expect((await read(grace.token, id)).json().status).toBe('pending');
      expect(ada.id).toBeDefined();
    });

    it('refuses a signature that is not lowercase hexadecimal, as the provider sends it', async () => {
      const { grace, id, paymentId } = await adaPaysThroughProvider();
      const body = `{ "id": "wh-z", "paymentId": "${paymentId}", "status": "succeeded", "at": "2026-11-17T10:00:00Z" }`;
      expect((await deliver(body, sign(body).toUpperCase())).statusCode).toBe(401);
      expect((await read(grace.token, id)).json().status).toBe('pending');
    });

    it('refuses every webhook when no secret is configured, as none can be checked', async () => {
      await app.stop();
      app = await createApplication({ databasePath, providerUrl: provider.url });
      const { grace, id, paymentId } = await adaPaysThroughProvider();
      expect((await webhookFor(paymentId, 'succeeded', '')).statusCode).toBe(401);
      expect((await read(grace.token, id)).json().status).toBe('pending');
    });
  });

  describe('a signed webhook', () => {
    it('is acknowledged with 204, and for a succeeded payment makes the settlement paid and counted at once', async () => {
      const { ada, grace, groupId, id, paymentId, payUrl } = await adaPaysThroughProvider();
      expect((await webhookFor(paymentId, 'succeeded')).statusCode).toBe(204);
      const settled = (await read(grace.token, id)).json();
      expect(settled).toEqual(expect.objectContaining({ status: 'paid', method: 'provider', amount: 300 }));
      expect(settled.payUrl).toBe(payUrl);
      expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(-200);
      const balances = await send(app, 'GET', `/groups/${groupId}/balances`, { token: grace.token });
      expect(balances.json().reduce((sum: number, b: { balance: number }) => sum + b.balance, 0)).toBe(0);
    });

    it('makes a failed payment failed: the balances never count it, and what it held is free again', async () => {
      const { ada, grace, groupId, id, paymentId } = await adaPaysThroughProvider();
      expect((await webhookFor(paymentId, 'failed')).statusCode).toBe(204);
      expect((await read(grace.token, id)).json()).toEqual(expect.objectContaining({ status: 'failed' }));
      expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(-500);
      // The 300 it held no longer counts, so the whole 500 can be settled in cash.
      const cash = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 500 },
      });
      expect(cash.statusCode).toBe(201);
    });

    it('changes nothing for a pending payment, which the provider has not ended', async () => {
      const { ada, grace, groupId, id, paymentId } = await adaPaysThroughProvider();
      expect((await webhookFor(paymentId, 'pending')).statusCode).toBe(204);
      expect((await read(grace.token, id)).json().status).toBe('pending');
      expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(-500);
    });

    it('changes nothing about a payment Tally does not know, and is still acknowledged', async () => {
      const { ada, grace, groupId, id } = await adaPaysThroughProvider();
      expect((await webhookFor('pay-unknown', 'succeeded')).statusCode).toBe(204);
      expect((await read(grace.token, id)).json().status).toBe('pending');
      expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(-500);
    });

    it('is acknowledged, and changes nothing, when its body is not an event', async () => {
      const { grace, id } = await adaPaysThroughProvider();
      const body = 'not json at all';
      expect((await deliver(body, sign(body))).statusCode).toBe(204);
      expect((await read(grace.token, id)).json().status).toBe('pending');
    });

    it('counts a payment once however often the provider repeats it', async () => {
      const { ada, groupId, paymentId } = await adaPaysThroughProvider();
      expect((await webhookFor(paymentId, 'succeeded')).statusCode).toBe(204);
      expect((await webhookFor(paymentId, 'succeeded')).statusCode).toBe(204);
      expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(-200);
    });

    it('keeps a payment that has ended as it ended: a later word from the provider changes nothing', async () => {
      const { grace, id, paymentId } = await adaPaysThroughProvider();
      await webhookFor(paymentId, 'succeeded');
      expect((await webhookFor(paymentId, 'failed')).statusCode).toBe(204);
      expect((await read(grace.token, id)).json().status).toBe('paid');

      const second = await adaPaysThroughProvider();
      await webhookFor(second.paymentId, 'failed');
      await webhookFor(second.paymentId, 'succeeded');
      expect((await read(second.grace.token, second.id)).json().status).toBe('failed');
    });

    it('keeps what it settled when the application stops and starts again', async () => {
      const { ada, grace, groupId, id, paymentId } = await adaPaysThroughProvider();
      await webhookFor(paymentId, 'succeeded');
      await app.stop();
      app = await createApplication({ databasePath, providerUrl: provider.url, providerWebhookSecret: SECRET });
      expect((await read(grace.token, id)).json()).toEqual(expect.objectContaining({ status: 'paid' }));
      expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(-200);
    });
  });

  describe('a webhook that comes twice, out of order, late, or at the same moment', () => {
    /** The webhook's body, as the provider sends it: the same bytes every time it is sent. */
    const bodyFor = (paymentId: string, status: string, webhookId: string) =>
      `{ "id": "${webhookId}", "paymentId": "${paymentId}", "status": "${status}", "at": "2026-11-17T10:00:00Z" }`;

    /** Sends `body` to `server` as the provider does: signed, with the bytes exactly as given. */
    const postTo = (server: Application['server'], body: string) =>
      server.inject({
        method: 'POST',
        url: '/v1/provider/webhooks',
        headers: { 'content-type': 'application/json', 'provider-signature': sign(body) },
        payload: body,
      });

    it('counts a payment once when the very same webhook is delivered twice', async () => {
      const { ada, groupId, paymentId } = await adaPaysThroughProvider();
      const body = bodyFor(paymentId, 'succeeded', 'wh-twice');
      expect((await deliver(body, sign(body))).statusCode).toBe(204);
      expect((await deliver(body, sign(body))).statusCode).toBe(204);
      expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(-200);
    });

    it('keeps a succeeded payment paid when a pending webhook arrives after it', async () => {
      const { ada, grace, groupId, id, paymentId } = await adaPaysThroughProvider();
      expect((await webhookFor(paymentId, 'succeeded')).statusCode).toBe(204);
      expect((await webhookFor(paymentId, 'pending')).statusCode).toBe(204);
      expect((await read(grace.token, id)).json().status).toBe('paid');
      expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(-200);
    });

    it('applies a webhook that arrives after the application stopped and started again', async () => {
      const { ada, grace, groupId, id, paymentId } = await adaPaysThroughProvider();
      await app.stop();
      app = await createApplication({ databasePath, providerUrl: provider.url, providerWebhookSecret: SECRET });
      expect((await webhookFor(paymentId, 'succeeded')).statusCode).toBe(204);
      expect((await read(grace.token, id)).json().status).toBe('paid');
      expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(-200);
    });

    it('counts a payment once when the same webhook reaches two applications on the same file at once', async () => {
      const { ada, groupId, paymentId } = await adaPaysThroughProvider();
      const other = await createApplication({
        databasePath,
        providerUrl: provider.url,
        providerWebhookSecret: SECRET,
      });
      try {
        const body = bodyFor(paymentId, 'succeeded', 'wh-both');
        const [first, second] = await Promise.all([postTo(app.server, body), postTo(other.server, body)]);
        expect([first.statusCode, second.statusCode]).toEqual([204, 204]);
        expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(-200);
      } finally {
        await other.stop();
      }
    });

    it('decides a succeeded and a failed webhook that arrive at once on two applications: the first decided stands', async () => {
      const { ada, grace, groupId, id, paymentId } = await adaPaysThroughProvider();
      const other = await createApplication({
        databasePath,
        providerUrl: provider.url,
        providerWebhookSecret: SECRET,
      });
      try {
        const [first, second] = await Promise.all([
          postTo(app.server, bodyFor(paymentId, 'succeeded', 'wh-ok')),
          postTo(other.server, bodyFor(paymentId, 'failed', 'wh-ko')),
        ]);
        expect([first.statusCode, second.statusCode]).toEqual([204, 204]);
        const settled = (await read(grace.token, id)).json().status;
        expect(['paid', 'failed']).toContain(settled);
        expect(await balanceOfAda(ada.token, groupId, ada.id)).toBe(settled === 'paid' ? -200 : -500);
      } finally {
        await other.stop();
      }
    });
  });
});
