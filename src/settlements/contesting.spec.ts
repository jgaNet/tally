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

describe('contesting a settlement through the provider', () => {
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

  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

  let counter = 0;
  /** The provider says `paymentId` has `status`, as a signed webhook. */
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

  async function createdGroup(token: string, name = 'Flat 4B'): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name, currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function read(token: string, id: string) {
    return send(app, 'GET', `/settlements/${id}`, { token });
  }

  async function contest(token: string, id: string) {
    return send(app, 'POST', `/settlements/${id}/contest`, { token });
  }

  async function balancesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>();
  }

  async function balanceOf(token: string, groupId: string, memberId: string) {
    return (await balancesOf(token, groupId)).find(b => b.memberId === memberId)?.balance;
  }

  async function auditOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/audit`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ action: string; by: string; subjectId: string; amount: number }[]>();
  }

  let scenarios = 0;
  /**
   * Ada owes Grace 500: Grace paid 1000 split between them. Grace owns the group. Ada pays `amount` of it through
   * the provider, and the provider says the payment succeeded, so the settlement is paid.
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

  describe('the payee contests', () => {
    it('a paid payment: it answers 204, and the settlement is contested, with its history', async () => {
      const { ada, grace, id } = await paidThroughProvider();
      const response = await contest(grace.token, id);
      expect(response.statusCode).toBe(204);
      const settlement = (await read(ada.token, id)).json();
      expect(settlement.status).toBe('contested');
      expect(settlement.history.map((entry: { status: string }) => entry.status)).toEqual([
        'pending',
        'paid',
        'contested',
      ]);
    });

    it('holds the settlement out of the balances: they are as they were before it was paid', async () => {
      const { ada, grace, groupId, id } = await paidThroughProvider();
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-200);
      await contest(grace.token, id);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
      expect(await balanceOf(grace.token, groupId, grace.id)).toBe(500);
    });

    it('still counts it as paid for what is owed: the payer can pay the rest, and no more', async () => {
      const { ada, grace, groupId, id } = await paidThroughProvider();
      await contest(grace.token, id);
      // Ada owes 500 less the 300 waiting at the provider's: 200 is still owed, so 300 more is too much.
      const tooMuch = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 300 },
      });
      expect(tooMuch.statusCode).toBe(409);
      expect(tooMuch.json().type).toBe('MoreThanIsOwed');
      const rest = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 200 },
      });
      expect(rest.statusCode).toBe(201);
    });

    it('keeps its payer and payee in the group: the payer cannot leave while it is contested', async () => {
      const { ada, grace, groupId, id } = await paidThroughProvider();
      await contest(grace.token, id);
      const leave = await send(app, 'POST', `/groups/${groupId}/leave`, { token: ada.token });
      expect(leave.statusCode).toBe(409);
      expect(leave.json().type).toBe('PaymentPending');
    });

    it('does not archive the group while it is contested, even when every balance is 0', async () => {
      const { ada, grace, groupId, id } = await paidThroughProvider();
      await contest(grace.token, id);
      // Ada paid 1000, split between the two of them: with the settlement held out, every balance is 0.
      const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: ada.token,
        payload: { description: 'Taxi', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
      });
      expect(expense.statusCode).toBe(201);
      expect((await balancesOf(grace.token, groupId)).every(b => b.balance === 0)).toBe(true);
      const archive = await send(app, 'POST', `/groups/${groupId}/archive`, { token: grace.token });
      expect(archive.statusCode).toBe(409);
      expect(archive.json().type).toBe('PaymentPending');
    });

    it('does not merge a group in which a payment is contested, whichever of the two groups it is in', async () => {
      const { grace, groupId, id } = await paidThroughProvider();
      await contest(grace.token, id);
      const other = await createdGroup(grace.token, 'Other');
      // The contested payment is in `groupId`: the group is refused whether it is merged away or kept.
      const mergedAway = await send(app, 'POST', `/groups/${other}/merge`, {
        token: grace.token,
        payload: { from: groupId },
      });
      expect(mergedAway.statusCode).toBe(409);
      expect(mergedAway.json().type).toBe('PaymentPending');
      const kept = await send(app, 'POST', `/groups/${groupId}/merge`, {
        token: grace.token,
        payload: { from: other },
      });
      expect(kept.statusCode).toBe(409);
      expect(kept.json().type).toBe('PaymentPending');
    });

    it('is recorded in the audit by the payee, with the amount, when it is contested', async () => {
      const { ada, grace, groupId, id } = await paidThroughProvider();
      await contest(grace.token, id);
      const entries = await auditOf(ada.token, groupId);
      expect(entries).toContainEqual(
        expect.objectContaining({ action: 'settlement-contested', by: grace.id, subjectId: id, amount: 300 }),
      );
    });

    it('is refused by a webhook about the payment: a refund or a failure changes nothing', async () => {
      const { ada, grace, groupId, id, paymentId } = await paidThroughProvider();
      await contest(grace.token, id);
      expect((await webhook(paymentId, 'refunded')).statusCode).toBe(204);
      expect((await webhook(paymentId, 'failed')).statusCode).toBe(204);
      expect((await read(ada.token, id)).json().status).toBe('contested');
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
    });

    it('cannot refund a contested payment', async () => {
      const { grace, id } = await paidThroughProvider();
      await contest(grace.token, id);
      const refund = await send(app, 'POST', `/settlements/${id}/refund`, { token: grace.token });
      expect(refund.statusCode).toBe(409);
      expect(refund.json().type).toBe('NotRefundable');
    });

    it('is refused to the payer with 403, and to someone outside the group with 404: nothing changes', async () => {
      const { ada, grace, id } = await paidThroughProvider();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const byPayer = await contest(ada.token, id);
      expect(byPayer.statusCode).toBe(403);
      expect(byPayer.json().type).toBe('NotPayee');
      const outsider = await contest(eve.token, id);
      const missing = await contest(eve.token, 'no-such-settlement');
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json()).toEqual(missing.json());
      expect((await read(grace.token, id)).json().status).toBe('paid');
    });

    it('is refused with 401 to a request with no token', async () => {
      const { id } = await paidThroughProvider();
      expect((await send(app, 'POST', `/settlements/${id}/contest`)).statusCode).toBe(401);
    });

    it('is refused for a payment that is not paid through the provider, and one still waiting', async () => {
      const { ada, grace, groupId } = await paidThroughProvider();
      const cash = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 100 },
      });
      expect(cash.statusCode).toBe(201);
      const byCash = await contest(grace.token, cash.json<{ id: string }>().id);
      expect(byCash.statusCode).toBe(409);
      expect(byCash.json().type).toBe('NotContestable');

      const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: ada.token,
        payload: { to: grace.id, amount: 50 },
      });
      const waiting = await contest(grace.token, asked.json<{ id: string }>().id);
      expect(waiting.statusCode).toBe(409);
      expect(waiting.json().type).toBe('NotContestable');
    });

    it('is refused once a member of the settlement has left the group', async () => {
      const { ada, grace, groupId, id } = await paidThroughProvider();
      // Ada leaves with her balance, which passes to the owner; nothing is waiting at the provider.
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ada.token })).statusCode).toBe(204);
      const response = await contest(grace.token, id);
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('MemberHasLeft');
      expect((await read(grace.token, id)).json().status).toBe('paid');
    });

    it('is refused in an archived group: a group is read only once archived', async () => {
      const { ada, grace, groupId, id } = await paidThroughProvider();
      // Ada pays 400, split between the two of them: with the payment counted, every balance is 0.
      const rest = await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: ada.token,
        payload: { description: 'Taxi', amount: 400, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
      });
      expect(rest.statusCode).toBe(201);
      expect((await send(app, 'POST', `/groups/${groupId}/archive`, { token: grace.token })).statusCode).toBe(204);
      const response = await contest(grace.token, id);
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('GroupArchived');
      expect((await read(grace.token, id)).json().status).toBe('paid');
    });
  });
});
