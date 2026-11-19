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

/** The day of the month `months` from the current one (UTC), as `YYYY-MM-DD`. */
function dayOfMonth(months: number, day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, day)).toISOString().slice(0, 10);
}

describe('a suspended account', () => {
  let app: Application;
  let provider: FakeProvider;

  beforeEach(async () => {
    provider = await startFakeProvider();
    app = await createApplication({
      databaseUrl: await temporaryDatabaseUrl(),
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

  /** Boss administers; Grace owns the group `Flat`, which Ada joins. Both have payout accounts. */
  async function setup() {
    const boss = await signedUpAccount(app, { email: 'boss@example.com', name: 'Boss' });
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const created = await send(app, 'POST', '/groups', {
      token: grace.token,
      payload: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, grace.token, ada.token, groupId);
    await setPayoutAccount(app, ada.token, 'acct-ada');
    await setPayoutAccount(app, grace.token, 'acct-grace');
    return { boss, ada, grace, groupId };
  }

  async function suspend(boss: string, id: string) {
    expect((await send(app, 'PUT', `/admin/accounts/${id}/suspension`, { token: boss })).statusCode).toBe(204);
  }

  async function reinstate(boss: string, id: string) {
    expect((await send(app, 'DELETE', `/admin/accounts/${id}/suspension`, { token: boss })).statusCode).toBe(204);
  }

  /** Grace records a dinner of 1000 split between Ada and Grace: Ada owes Grace 500. */
  function dinner(token: string, groupId: string, members: string[], amount = 1000) {
    return send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      payload: { description: 'Dinner', amount, date: todayInUtc(), splitBetween: members },
    });
  }

  async function expensesOf(token: string, groupId: string) {
    return send(app, 'GET', `/groups/${groupId}/expenses`, { token });
  }

  async function balanceOf(token: string, groupId: string, memberId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    return response.json<{ memberId: string; balance: number }[]>().find(b => b.memberId === memberId)?.balance;
  }

  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');
  let counter = 0;
  /** The provider says `paymentId` has `status`, as a signed webhook. */
  async function webhook(paymentId: string, status: string) {
    counter += 1;
    const body = `{ "id": "wh-${counter}", "paymentId": "${paymentId}", "status": "${status}", "at": "2026-11-17T10:00:00Z" }`;
    const response = await app.server.inject({
      method: 'POST',
      url: '/v1/provider/webhooks',
      headers: { 'content-type': 'application/json', 'provider-signature': sign(body) },
      payload: body,
    });
    expect(response.statusCode).toBe(204);
  }

  /** `from` pays `to` `amount` through the provider, which says it succeeded: a paid settlement, its id answered. */
  async function paidThroughProvider(groupId: string, from: string, to: string, amount: number): Promise<string> {
    const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: from,
      payload: { to, amount },
    });
    expect(asked.statusCode).toBe(201);
    await webhook(provider.payments[provider.payments.length - 1].id, 'succeeded');
    return asked.json<{ id: string }>().id;
  }

  describe('is refused what records money, by the one rule, and it changes nothing', () => {
    it('recording an expense', async () => {
      const { boss, ada, grace, groupId } = await setup();
      await suspend(boss.token, ada.id);
      const refused = await dinner(ada.token, groupId, [ada.id, grace.id]);
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ type: string }>().type).toBe('AccountSuspended');
      expect((await expensesOf(grace.token, groupId)).json()).toEqual([]);
    });

    it('setting up a recurring expense', async () => {
      const { boss, ada, grace, groupId } = await setup();
      await suspend(boss.token, ada.id);
      const refused = await send(app, 'POST', `/groups/${groupId}/recurring`, {
        token: ada.token,
        payload: {
          description: 'Rent',
          amount: 90000,
          startsOn: dayOfMonth(1, 5),
          splitBetween: [ada.id, grace.id],
        },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ type: string }>().type).toBe('AccountSuspended');
      expect((await send(app, 'GET', `/groups/${groupId}/recurring`, { token: grace.token })).json()).toEqual([]);
    });

    it('recording a settlement in cash, by it as the payee', async () => {
      const { boss, ada, grace, groupId } = await setup();
      expect((await dinner(grace.token, groupId, [ada.id, grace.id])).statusCode).toBe(201);
      await suspend(boss.token, grace.id);
      const refused = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 300 },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ type: string }>().type).toBe('AccountSuspended');
      expect(await balanceOf(grace.token, groupId, ada.id)).toBe(-500);
    });

    it('asking to pay through the provider, as the payer', async () => {
      const { boss, ada, grace, groupId } = await setup();
      expect((await dinner(grace.token, groupId, [ada.id, grace.id])).statusCode).toBe(201);
      await suspend(boss.token, ada.id);
      const refused = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: ada.token,
        payload: { to: grace.id, amount: 300 },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ type: string }>().type).toBe('AccountSuspended');
      expect(provider.requests).toHaveLength(0);
      expect(await balanceOf(grace.token, groupId, ada.id)).toBe(-500);
    });

    it('asking for a netting', async () => {
      const { boss, ada, grace } = await setup();
      await suspend(boss.token, ada.id);
      const refused = await send(app, 'POST', '/nettings', {
        token: ada.token,
        payload: { with: grace.id, currency: 'EUR' },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ type: string }>().type).toBe('AccountSuspended');
    });

    it('is refused the same way for each expense, and nothing is refused once reinstated', async () => {
      const { boss, ada, grace, groupId } = await setup();
      await suspend(boss.token, ada.id);
      expect((await dinner(ada.token, groupId, [ada.id, grace.id])).json<{ type: string }>().type).toBe(
        'AccountSuspended',
      );
      await reinstate(boss.token, ada.id);
      expect((await dinner(ada.token, groupId, [ada.id, grace.id])).statusCode).toBe(201);
    });
  });

  describe('still does everything else', () => {
    it('reads, edits and deletes its expenses, and leaves a group whose balance is 0', async () => {
      const { boss, ada, grace, groupId } = await setup();
      const recorded = await dinner(ada.token, groupId, [ada.id, grace.id]);
      const id = recorded.json<{ id: string }>().id;
      await suspend(boss.token, ada.id);

      const read = await send(app, 'GET', `/expenses/${id}`, { token: ada.token });
      expect(read.statusCode).toBe(200);
      const edited = await send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: {
          description: 'Dinner, corrected',
          amount: 1000,
          date: todayInUtc(),
          splitBetween: [ada.id, grace.id],
          version: read.json<{ version: number }>().version,
        },
      });
      expect(edited.statusCode).toBe(204);
      expect((await send(app, 'DELETE', `/expenses/${id}`, { token: ada.token })).statusCode).toBe(204);
      expect(await balanceOf(grace.token, groupId, ada.id)).toBe(0);
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ada.token })).statusCode).toBe(204);
    });

    it('refunds a payment it was paid through the provider, and contests another', async () => {
      const { boss, ada, grace, groupId } = await setup();
      expect((await dinner(grace.token, groupId, [ada.id, grace.id])).statusCode).toBe(201);
      const refunded = await paidThroughProvider(groupId, ada.token, grace.id, 300);
      const contested = await paidThroughProvider(groupId, ada.token, grace.id, 200);
      await suspend(boss.token, grace.id);

      expect((await send(app, 'POST', `/settlements/${refunded}/refund`, { token: grace.token })).statusCode).toBe(204);
      expect((await send(app, 'POST', `/settlements/${contested}/contest`, { token: grace.token })).statusCode).toBe(
        204,
      );
      expect(
        (await send(app, 'GET', `/settlements/${contested}`, { token: grace.token })).json<{ status: string }>().status,
      ).toBe('contested');
    });
  });

  describe('does not stop the others of its groups', () => {
    it('who may still put it in a split, and record its payment to them in cash', async () => {
      const { boss, ada, grace, groupId } = await setup();
      // Ada owes Grace 500 once this dinner is recorded.
      expect((await dinner(grace.token, groupId, [ada.id, grace.id])).statusCode).toBe(201);
      await suspend(boss.token, ada.id);

      expect((await dinner(grace.token, groupId, [ada.id, grace.id])).statusCode).toBe(201);
      const cash = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 100 },
      });
      expect(cash.statusCode).toBe(201);
      // Two dinners of 500 each for Ada, less the 100 she paid in cash.
      expect(await balanceOf(grace.token, groupId, ada.id)).toBe(-900);
    });

    it('who may pay it through the provider', async () => {
      const { boss, ada, grace, groupId } = await setup();
      // Grace owes Ada 1000 once this dinner is recorded.
      expect((await dinner(ada.token, groupId, [ada.id, grace.id], 2000)).statusCode).toBe(201);
      await suspend(boss.token, ada.id);

      expect(await paidThroughProvider(groupId, grace.token, ada.id, 50)).toBeTruthy();
      expect(provider.requests.at(-1)?.payee).toBe('acct-ada');
    });
  });

  describe('its recurring expenses', () => {
    it('record nothing while it is suspended, and their days wait for its reinstatement', async () => {
      const { boss, ada, grace, groupId } = await setup();
      const created = await send(app, 'POST', `/groups/${groupId}/recurring`, {
        token: ada.token,
        payload: { description: 'Rent', amount: 90000, startsOn: '2026-09-05', splitBetween: [ada.id, grace.id] },
      });
      const id = created.json<{ id: string }>().id;
      await suspend(boss.token, ada.id);

      await app.runJobs(new Date('2026-11-10T08:00:00Z'));
      expect((await expensesOf(grace.token, groupId)).json()).toEqual([]);
      expect((await send(app, 'GET', `/recurring/${id}`, { token: grace.token })).json<{ next: string }>().next).toBe(
        '2026-09-05',
      );

      await reinstate(boss.token, ada.id);
      await app.runJobs(new Date('2026-11-10T08:00:00Z'));
      const dates = (await expensesOf(grace.token, groupId)).json<{ date: string }[]>().map(expense => expense.date);
      expect(dates.sort()).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
      expect((await send(app, 'GET', `/recurring/${id}`, { token: grace.token })).json<{ next: string }>().next).toBe(
        '2026-12-05',
      );
    });
  });
});
