import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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

describe('a group’s settlements and their history', () => {
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
  /** The provider says `paymentId` has `status`, as a signed webhook. */
  function webhookFor(paymentId: string, status: string) {
    counter += 1;
    const body = `{ "id": "wh-${counter}", "paymentId": "${paymentId}", "status": "${status}", "at": "2026-11-17T10:00:00Z" }`;
    return app.server.inject({
      method: 'POST',
      url: `/${app.apiPrefix}/provider/webhooks`,
      headers: { 'content-type': 'application/json', 'provider-signature': sign(body) },
      payload: body,
    });
  }

  let scenarios = 0;
  /** Ada owes Grace 500: Grace paid 1000 split between the two of them. Grace has a payout account. */
  async function adaOwesGrace() {
    scenarios += 1;
    const ada = await signedUpAccount(app, { email: `ada${scenarios}@example.com` });
    const grace = await signedUpAccount(app, { email: `grace${scenarios}@example.com`, name: 'Grace' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await setPayoutAccount(app, grace.token, `acct-grace-${scenarios}`);
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: grace.token,
      payload: { description: 'Dinner', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(expense.statusCode).toBe(201);
    return { ada, grace, groupId };
  }

  async function payCash(graceToken: string, groupId: string, from: string, amount: number): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: graceToken,
      payload: { from, amount },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** Ada asks the provider to pay Grace `amount`, and answers the settlement's id and the provider's payment id. */
  async function askProvider(ada: { token: string }, groupId: string, graceId: string, amount: number) {
    const response = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: ada.token,
      payload: { to: graceId, amount },
    });
    expect(response.statusCode).toBe(201);
    const payment = provider.payments[provider.payments.length - 1];
    return { id: response.json<{ id: string }>().id, paymentId: payment.id };
  }

  async function read(token: string, id: string) {
    return send(app, 'GET', `/settlements/${id}`, { token });
  }

  /** The statuses of a settlement, in order, read from the settlement itself. */
  async function statusesOf(token: string, id: string): Promise<string[]> {
    const response = await read(token, id);
    expect(response.statusCode).toBe(200);
    return response.json<{ history: { status: string }[] }>().history.map(entry => entry.status);
  }

  describe('the group’s settlements', () => {
    it('lists them, the most recently recorded first, each as it reads on its own', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const first = await payCash(grace.token, groupId, ada.id, 100);
      const second = await payCash(grace.token, groupId, ada.id, 200);
      const asked = await askProvider(ada, groupId, grace.id, 50);

      const listed = await send(app, 'GET', `/groups/${groupId}/settlements`, { token: grace.token });
      expect(listed.statusCode).toBe(200);
      const settlements = listed.json<{ id: string }[]>();
      expect(settlements.map(s => s.id)).toEqual([asked.id, second, first]);
      for (const settlement of settlements) {
        expect((await read(ada.token, settlement.id)).json()).toEqual(settlement);
      }
    });

    it('answers an empty list for a group with no settlements', async () => {
      const { ada, groupId } = await adaOwesGrace();
      const listed = await send(app, 'GET', `/groups/${groupId}/settlements`, { token: ada.token });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual([]);
    });

    it('still shows a member who has left to the members, and to them the settlements of that member too', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const settled = await payCash(grace.token, groupId, ada.id, 500);
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: grace.token })).statusCode).toBe(204);

      const seenByAda = await send(app, 'GET', `/groups/${groupId}/settlements`, { token: ada.token });
      expect(seenByAda.statusCode).toBe(200);
      expect(seenByAda.json<{ id: string }[]>().map(s => s.id)).toEqual([settled]);
      // Grace has left, so the group does not exist for her.
      expect((await send(app, 'GET', `/groups/${groupId}/settlements`, { token: grace.token })).statusCode).toBe(404);
    });

    it('answers 404 to a person who is not a member, the same as for a group that does not exist', async () => {
      const { ada, groupId } = await adaOwesGrace();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const outsider = await send(app, 'GET', `/groups/${groupId}/settlements`, { token: eve.token });
      const missing = await send(app, 'GET', `/groups/00000000-0000-0000-0000-000000000000/settlements`, {
        token: ada.token,
      });
      expect(outsider.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(outsider.json()).toEqual(missing.json());
    });

    it('answers 401 to a request with no token', async () => {
      const { groupId } = await adaOwesGrace();
      expect((await send(app, 'GET', `/groups/${groupId}/settlements`)).statusCode).toBe(401);
    });
  });

  describe('a settlement’s history', () => {
    it('is paid from the moment a cash settlement is recorded, the time Tally recorded it', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const before = Date.now();
      const id = await payCash(grace.token, groupId, ada.id, 300);
      const after = Date.now();
      const history = (await read(ada.token, id)).json<{ history: { status: string; at: string }[] }>().history;
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('paid');
      expect(Date.parse(history[0].at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(history[0].at)).toBeLessThanOrEqual(after);
    });

    it('is pending, then paid, for a provider payment that succeeds', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const { id, paymentId } = await askProvider(ada, groupId, grace.id, 300);
      expect(await statusesOf(ada.token, id)).toEqual(['pending']);
      expect((await webhookFor(paymentId, 'succeeded')).statusCode).toBe(204);
      expect(await statusesOf(grace.token, id)).toEqual(['pending', 'paid']);
    });

    it('is pending, then failed, for a provider payment that fails', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const { id, paymentId } = await askProvider(ada, groupId, grace.id, 300);
      expect((await webhookFor(paymentId, 'failed')).statusCode).toBe(204);
      expect(await statusesOf(grace.token, id)).toEqual(['pending', 'failed']);
    });

    it('is pending, paid, refunding and refunded for a payment refunded through the provider', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const { id, paymentId } = await askProvider(ada, groupId, grace.id, 300);
      await webhookFor(paymentId, 'succeeded');
      expect((await send(app, 'POST', `/settlements/${id}/refund`, { token: grace.token })).statusCode).toBe(204);
      expect(await statusesOf(grace.token, id)).toEqual(['pending', 'paid', 'refunding']);
      await webhookFor(paymentId, 'refunded');
      expect(await statusesOf(grace.token, id)).toEqual(['pending', 'paid', 'refunding', 'refunded']);
    });

    it('ends as paid again when the provider refuses the refund, and says so in its history', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const { id, paymentId } = await askProvider(ada, groupId, grace.id, 300);
      await webhookFor(paymentId, 'succeeded');
      provider.refundMode = 'refuse';
      expect((await send(app, 'POST', `/settlements/${id}/refund`, { token: grace.token })).statusCode).toBe(409);
      expect(await statusesOf(grace.token, id)).toEqual(['pending', 'paid', 'refunding', 'paid']);
    });

    it('adds only the status a webhook moves to, when it moves past one the settlement never had', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const { id, paymentId } = await askProvider(ada, groupId, grace.id, 300);
      expect((await webhookFor(paymentId, 'refunded')).statusCode).toBe(204);
      expect(await statusesOf(grace.token, id)).toEqual(['pending', 'refunded']);
    });

    it('adds nothing for a webhook that changes nothing: a redelivery, a pending word, or one Tally does not know', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const { id, paymentId } = await askProvider(ada, groupId, grace.id, 300);
      await webhookFor(paymentId, 'succeeded');
      await webhookFor(paymentId, 'succeeded');
      await webhookFor(paymentId, 'pending');
      await webhookFor(paymentId, 'something-new');
      expect(await statusesOf(grace.token, id)).toEqual(['pending', 'paid']);
    });

    it('records each status at the time Tally learned it, the earliest first', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const { id, paymentId } = await askProvider(ada, groupId, grace.id, 300);
      const before = Date.now();
      await webhookFor(paymentId, 'succeeded');
      const after = Date.now();
      const history = (await read(grace.token, id)).json<{ history: { status: string; at: string }[] }>().history;
      expect(history.map(entry => entry.status)).toEqual(['pending', 'paid']);
      expect(Date.parse(history[1].at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(history[1].at)).toBeLessThanOrEqual(after);
      expect(Date.parse(history[0].at)).toBeLessThanOrEqual(Date.parse(history[1].at));
    });

    it('is the same to every member, and a read changes nothing in it', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const id = await payCash(grace.token, groupId, ada.id, 300);
      const once = (await read(ada.token, id)).json();
      const twice = (await read(grace.token, id)).json();
      expect(twice).toEqual(once);
      expect(once.history).toHaveLength(1);
    });
  });

  describe('a settlement recorded before history was kept', () => {
    it('has the statuses it had, reconstructed from its own status, when the schema is brought up to date', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const cash = await payCash(grace.token, groupId, ada.id, 100);
      const pending = await askProvider(ada, groupId, grace.id, 50);
      const paid = await askProvider(ada, groupId, grace.id, 60);
      await webhookFor(paid.paymentId, 'succeeded');
      const failed = await askProvider(ada, groupId, grace.id, 70);
      await webhookFor(failed.paymentId, 'failed');
      const refunded = await askProvider(ada, groupId, grace.id, 80);
      await webhookFor(refunded.paymentId, 'succeeded');
      await send(app, 'POST', `/settlements/${refunded.id}/refund`, { token: grace.token });
      await webhookFor(refunded.paymentId, 'refunded');
      // What each settlement had, as the history kept from now on says it did.
      const kept: Record<string, string[]> = {
        [cash]: ['paid'],
        [pending.id]: ['pending'],
        [paid.id]: ['pending', 'paid'],
        [failed.id]: ['pending', 'failed'],
        [refunded.id]: ['pending', 'paid', 'refunding', 'refunded'],
      };
      await app.stop();

      // Takes the schema back to before the history was kept, undoing the steps that came after it too (the
      // balances' transfers, the expenses' original amounts, the recurring expenses, the categories and budgets, the
      // split templates, the receipts and the archiving), and brings it up to date again.
      const db = new DatabaseSync(databasePath);
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      db.exec(`
        DROP TABLE receipts;
        DROP TABLE split_templates;
        DROP TABLE budget_passings;
        DROP TABLE budgets;
        ALTER TABLE expenses DROP COLUMN category;
        DROP TABLE recurring;
        DROP TABLE balance_transfers;
        DROP TABLE settlement_statuses;
        ALTER TABLE expenses DROP COLUMN original_currency;
        ALTER TABLE expenses DROP COLUMN original_amount;
        ALTER TABLE expenses DROP COLUMN original_rate;
        ALTER TABLE groups DROP COLUMN archived_at;
        PRAGMA user_version = ${version - 8};
      `);
      db.close();
      app = await createApplication({ databasePath, providerUrl: provider.url, providerWebhookSecret: SECRET });

      // The refund's own steps were not known then, so a refunded settlement is reconstructed without `refunding`.
      const reconstructed = { ...kept, [refunded.id]: ['pending', 'paid', 'refunded'] };
      for (const [id, statuses] of Object.entries(reconstructed)) {
        expect(await statusesOf(grace.token, id)).toEqual(statuses);
      }
    });
  });
});
