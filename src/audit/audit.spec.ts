import { createHmac } from 'node:crypto';
import { type Application, createApplication } from '../app';
import { openDatabase } from '../database';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeProvider,
  type FakeReceiptsStore,
  exited,
  joinThroughInvitation,
  send,
  setPayoutAccount,
  signedUpAccount,
  startFakeProvider,
  startFakeReceiptsStore,
  startServerProcess,
  temporaryDatabasePath,
  validSignup,
} from '../test-support';

const SECRET = 'shared-secret';

interface Entry {
  id: string;
  at: string;
  by: string;
  action: string;
  subjectId: string;
  amount: number;
}

/** The day of the month `months` from the current one (UTC), as `YYYY-MM-DD`. */
function dayOfMonth(months: number, day: number): string {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, day));
  return month.toISOString().slice(0, 10);
}

describe('the audit of a group', () => {
  let app: Application;
  let databasePath: string;
  let provider: FakeProvider;
  let receipts: FakeReceiptsStore;

  const configured = (path: string) =>
    createApplication({
      databasePath: path,
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 300,
      receiptsUrl: receipts.url,
      receiptsTimeoutMs: 300,
    });

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    provider = await startFakeProvider();
    receipts = await startFakeReceiptsStore();
    app = await configured(databasePath);
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
    await receipts.close();
  });

  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

  /** Sends a webhook about `paymentId` saying `status`, as the provider does: signed, and its body as sent. */
  let webhooks = 0;
  function webhookBody(paymentId: string, status: string): string {
    webhooks += 1;
    return `{ "id": "wh-${webhooks}", "paymentId": "${paymentId}", "status": "${status}", "at": "2026-11-17T10:00:00Z" }`;
  }
  function deliver(server: Application, body: string) {
    return server.server.inject({
      method: 'POST',
      url: `/${server.apiPrefix}/provider/webhooks`,
      headers: { 'content-type': 'application/json', 'provider-signature': sign(body) },
      payload: body,
    });
  }
  const webhookFor = (paymentId: string, status: string) => deliver(app, webhookBody(paymentId, status));

  async function audit(token: string, groupId: string): Promise<Entry[]> {
    const response = await send(app, 'GET', `/groups/${groupId}/audit`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<Entry[]>();
  }

  /** Ada owns a group that Grace and Linus joined, in that order. Nothing is recorded yet. */
  async function threeMembers() {
    const ada = await signedUpAccount(app, { email: 'ada@example.com', name: 'Ada' });
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    return { ada, grace, linus, groupId };
  }

  async function recordExpense(token: string, groupId: string, payload: Record<string, unknown>): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      payload: { description: 'Dinner', date: todayInUtc(), ...payload },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** Grace paid 1000 split between Ada and Grace: Ada owes 500. Grace has a payout account. */
  async function adaOwesGrace() {
    const ada = await signedUpAccount(app, { email: 'ada@example.com', name: 'Ada' });
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await setPayoutAccount(app, grace.token, 'acct-grace');
    await recordExpense(grace.token, groupId, { amount: 1000, splitBetween: [ada.id, grace.id] });
    return { ada, grace, groupId };
  }

  async function askForProviderPayment(token: string, groupId: string, to: string, amount: number): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token,
      payload: { to, amount },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** The provider's id of the payment asked for last. */
  const lastPaymentId = () => provider.payments[provider.payments.length - 1].id;

  describe('what it records', () => {
    it('records an expense recorded, by its payer, with its amount, about the expense', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const expenseId = await recordExpense(grace.token, groupId, {
        amount: 9000,
        splitBetween: [ada.id, grace.id, linus.id],
      });
      const entries = await audit(ada.token, groupId);
      expect(entries).toEqual([
        {
          id: expect.any(String),
          at: expect.any(String),
          by: grace.id,
          action: 'expense-recorded',
          subjectId: expenseId,
          amount: 9000,
        },
      ]);
      expect(Number.isNaN(Date.parse(entries[0].at))).toBe(false);
    });

    it('records an expense in another currency at its amount in the group’s currency', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const expenseId = await recordExpense(grace.token, groupId, {
        original: { currency: 'USD', amount: 10000, rate: '0.9' },
        splitBetween: [ada.id, grace.id],
      });
      expect(await audit(ada.token, groupId)).toEqual([
        expect.objectContaining({ by: grace.id, action: 'expense-recorded', subjectId: expenseId, amount: 9000 }),
      ]);
    });

    it('records an expense the background job records, by its payer', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const created = await send(app, 'POST', `/groups/${groupId}/recurring`, {
        token: grace.token,
        payload: { description: 'Rent', amount: 90000, startsOn: dayOfMonth(0, 1), splitBetween: [ada.id, grace.id] },
      });
      expect(created.statusCode).toBe(201);
      app.runJobs();
      const expenses = await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ada.token });
      const [recorded] = expenses.json<{ id: string }[]>();
      expect(await audit(ada.token, groupId)).toEqual([
        expect.objectContaining({ by: grace.id, action: 'expense-recorded', subjectId: recorded.id, amount: 90000 }),
      ]);
    });

    it('records an expense edited, by who edited it, with its amount after the edit', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const expenseId = await recordExpense(grace.token, groupId, { amount: 900, splitBetween: [ada.id, grace.id] });
      const edit = (token: string, version: number, amount: number) =>
        send(app, 'PUT', `/expenses/${expenseId}`, {
          token,
          payload: { description: 'Dinner', date: todayInUtc(), amount, splitBetween: [ada.id, grace.id], version },
        });
      expect((await edit(grace.token, 1, 600)).statusCode).toBe(204);
      expect((await edit(ada.token, 2, 500)).statusCode).toBe(204);
      expect(await audit(ada.token, groupId)).toEqual([
        expect.objectContaining({ by: grace.id, action: 'expense-recorded', subjectId: expenseId, amount: 900 }),
        expect.objectContaining({ by: grace.id, action: 'expense-edited', subjectId: expenseId, amount: 600 }),
        expect.objectContaining({ by: ada.id, action: 'expense-edited', subjectId: expenseId, amount: 500 }),
      ]);
    });

    it('records an expense deleted, by who deleted it, with the amount it had; the entry stays', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const expenseId = await recordExpense(grace.token, groupId, { amount: 900, splitBetween: [ada.id, grace.id] });
      expect((await send(app, 'DELETE', `/expenses/${expenseId}`, { token: ada.token })).statusCode).toBe(204);
      expect((await send(app, 'GET', `/expenses/${expenseId}`, { token: ada.token })).statusCode).toBe(404);
      expect(await audit(ada.token, groupId)).toEqual([
        expect.objectContaining({ by: grace.id, action: 'expense-recorded', subjectId: expenseId, amount: 900 }),
        expect.objectContaining({ by: ada.id, action: 'expense-deleted', subjectId: expenseId, amount: 900 }),
      ]);
    });

    it('records a cash settlement when it is recorded, by its payee, with its amount', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const created = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 300 },
      });
      expect(created.statusCode).toBe(201);
      const settled = (await audit(ada.token, groupId)).filter(entry => entry.action === 'settlement-paid');
      expect(settled).toEqual([
        {
          id: expect.any(String),
          at: expect.any(String),
          by: grace.id,
          action: 'settlement-paid',
          subjectId: created.json<{ id: string }>().id,
          amount: 300,
        },
      ]);
    });

    it('records a provider settlement as paid when the provider says it succeeded, by its payer, once', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const id = await askForProviderPayment(ada.token, groupId, grace.id, 300);
      const settlementEntries = async () => (await audit(ada.token, groupId)).filter(entry => entry.subjectId === id);
      expect(await settlementEntries()).toEqual([]);

      expect((await webhookFor(lastPaymentId(), 'succeeded')).statusCode).toBe(204);
      expect(await settlementEntries()).toEqual([
        {
          id: expect.any(String),
          at: expect.any(String),
          by: ada.id,
          action: 'settlement-paid',
          subjectId: id,
          amount: 300,
        },
      ]);

      // The same word again changes nothing, and so writes nothing.
      expect((await webhookFor(lastPaymentId(), 'succeeded')).statusCode).toBe(204);
      expect(await settlementEntries()).toHaveLength(1);
    });

    it('records no entry for a provider payment that failed', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const id = await askForProviderPayment(ada.token, groupId, grace.id, 300);
      expect((await webhookFor(lastPaymentId(), 'failed')).statusCode).toBe(204);
      expect((await audit(ada.token, groupId)).filter(entry => entry.subjectId === id)).toEqual([]);
    });

    it('records a refund of a paid settlement when the provider says it is refunded, by its payee, once', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const id = await askForProviderPayment(ada.token, groupId, grace.id, 300);
      expect((await webhookFor(lastPaymentId(), 'succeeded')).statusCode).toBe(204);

      const asked = await send(app, 'POST', `/settlements/${id}/refund`, { token: grace.token });
      expect(asked.statusCode).toBe(204);
      // Asking for the refund is not a change of money: only the provider's word is.
      expect((await audit(ada.token, groupId)).filter(entry => entry.subjectId === id)).toHaveLength(1);

      expect((await webhookFor(lastPaymentId(), 'refunded')).statusCode).toBe(204);
      expect((await audit(ada.token, groupId)).filter(entry => entry.subjectId === id)).toEqual([
        expect.objectContaining({ by: ada.id, action: 'settlement-paid', amount: 300 }),
        {
          id: expect.any(String),
          at: expect.any(String),
          by: grace.id,
          action: 'settlement-refunded',
          subjectId: id,
          amount: 300,
        },
      ]);

      expect((await webhookFor(lastPaymentId(), 'refunded')).statusCode).toBe(204);
      expect((await audit(ada.token, groupId)).filter(entry => entry.subjectId === id)).toHaveLength(2);
    });

    it('records no refund for a payment refunded while still pending, since no balance counted it', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const id = await askForProviderPayment(ada.token, groupId, grace.id, 300);
      expect((await webhookFor(lastPaymentId(), 'refunded')).statusCode).toBe(204);
      // Its success arriving late changes nothing: the refund has ended it.
      expect((await webhookFor(lastPaymentId(), 'succeeded')).statusCode).toBe(204);
      expect((await audit(ada.token, groupId)).filter(entry => entry.subjectId === id)).toEqual([]);
    });

    it('records a member who left with a balance as passed on, by that member, with the balance they left with', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      // Ada paid 900 split between the three: Grace and Linus each owe 300.
      await recordExpense(ada.token, groupId, { amount: 900, splitBetween: [ada.id, grace.id, linus.id] });
      const paid = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: ada.token,
        payload: { from: linus.id, amount: 300 },
      });
      expect(paid.statusCode).toBe(201);
      // Linus is at 0 now: leaving passes nothing on.
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: linus.token })).statusCode).toBe(204);
      expect((await audit(ada.token, groupId)).filter(entry => entry.action === 'balance-passed')).toEqual([]);

      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: grace.token })).statusCode).toBe(204);
      expect((await audit(ada.token, groupId)).filter(entry => entry.action === 'balance-passed')).toEqual([
        {
          id: expect.any(String),
          at: expect.any(String),
          by: grace.id,
          action: 'balance-passed',
          subjectId: grace.id,
          amount: -300,
        },
      ]);
    });

    it('records nothing for a payment asked for, a recurring expense set up, a budget, or a receipt', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const expenseId = (await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ada.token })).json<
        { id: string }[]
      >()[0].id;
      const before = await audit(ada.token, groupId);

      await askForProviderPayment(ada.token, groupId, grace.id, 300);
      expect(
        (
          await send(app, 'POST', `/groups/${groupId}/recurring`, {
            token: grace.token,
            payload: {
              description: 'Rent',
              amount: 90000,
              startsOn: dayOfMonth(1, 5),
              splitBetween: [ada.id, grace.id],
            },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (await send(app, 'PUT', `/groups/${groupId}/budgets/groceries`, { token: ada.token, payload: { amount: 100 } }))
          .statusCode,
      ).toBe(204);
      const receipt = await app.server.inject({
        method: 'PUT',
        url: `/${app.apiPrefix}/expenses/${expenseId}/receipt`,
        headers: { authorization: `Bearer ${ada.token}`, 'content-type': 'application/octet-stream' },
        payload: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      });
      expect(receipt.statusCode).toBe(204);

      expect(await audit(ada.token, groupId)).toEqual(before);
    });

    it('records no entry for a change that is refused', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const expenseId = (await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ada.token })).json<
        { id: string }[]
      >()[0].id;
      const before = await audit(ada.token, groupId);

      await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 999 },
      });
      // Linus is a member who neither paid the expense nor owns the group: not allowed to change it.
      const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
      await joinThroughInvitation(app, ada.token, linus.token, groupId);
      expect(
        (
          await send(app, 'PUT', `/expenses/${expenseId}`, {
            token: linus.token,
            payload: {
              description: 'Dinner',
              date: todayInUtc(),
              amount: 1,
              splitBetween: [ada.id, grace.id],
              version: 1,
            },
          })
        ).statusCode,
      ).toBe(403);
      // A stale version is refused too.
      expect(
        (
          await send(app, 'PUT', `/expenses/${expenseId}`, {
            token: grace.token,
            payload: {
              description: 'Dinner',
              date: todayInUtc(),
              amount: 1,
              splitBetween: [ada.id, grace.id],
              version: 7,
            },
          })
        ).statusCode,
      ).toBe(409);
      expect((await send(app, 'DELETE', `/expenses/${expenseId}`, { token: linus.token })).statusCode).toBe(403);

      expect(await audit(ada.token, groupId)).toEqual(before);
    });
  });

  describe('reading it', () => {
    it('answers the oldest change first, each in the order it was made', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const first = await recordExpense(grace.token, groupId, { amount: 900, splitBetween: [ada.id, grace.id] });
      const second = await recordExpense(linus.token, groupId, { amount: 300, splitBetween: [linus.id] });
      expect((await send(app, 'DELETE', `/expenses/${first}`, { token: ada.token })).statusCode).toBe(204);

      const entries = await audit(ada.token, groupId);
      expect(entries.map(entry => [entry.action, entry.subjectId])).toEqual([
        ['expense-recorded', first],
        ['expense-recorded', second],
        ['expense-deleted', first],
      ]);
      const times = entries.map(entry => Date.parse(entry.at));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    it('is the same however many times it is read, and every member sees it', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await recordExpense(grace.token, groupId, { amount: 900, splitBetween: [ada.id, grace.id] });
      const once = await audit(grace.token, groupId);
      expect(await audit(grace.token, groupId)).toEqual(once);
      expect(await audit(ada.token, groupId)).toEqual(once);
      expect(once).toHaveLength(1);
    });

    it('is refused to anyone who is not a member of the group, as if the group did not exist', async () => {
      const { ada, groupId } = await threeMembers();
      const outsider = await signedUpAccount(app, { email: 'outsider@example.com', name: 'Outsider' });
      const notAMember = await send(app, 'GET', `/groups/${groupId}/audit`, { token: outsider.token });
      expect(notAMember.statusCode).toBe(404);
      const noSuchGroup = await send(app, 'GET', '/groups/no-such-group/audit', { token: ada.token });
      expect(noSuchGroup.statusCode).toBe(404);
      expect(notAMember.json()).toEqual(noSuchGroup.json());
    });

    it('is refused without a sign-in', async () => {
      const { groupId } = await threeMembers();
      expect((await send(app, 'GET', `/groups/${groupId}/audit`)).statusCode).toBe(401);
    });
  });

  describe('what keeps it', () => {
    it('never changes or removes an entry, whatever writes to the file', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await recordExpense(grace.token, groupId, { amount: 900, splitBetween: [ada.id, grace.id] });
      const raw = openDatabase(databasePath);
      try {
        expect(() => raw.prepare('UPDATE audit_entries SET amount = 1').run()).toThrow(
          'an audit entry is never changed',
        );
        expect(() => raw.prepare('DELETE FROM audit_entries').run()).toThrow('an audit entry is never removed');
      } finally {
        raw.close();
      }
      expect((await audit(ada.token, groupId))[0].amount).toBe(900);
    });

    it('has one entry for a change, when several servers hear the same word from the provider at once', async () => {
      const { ada, grace, groupId } = await adaOwesGrace();
      const id = await askForProviderPayment(ada.token, groupId, grace.id, 300);
      const body = webhookBody(lastPaymentId(), 'succeeded');
      const other = await configured(databasePath);
      try {
        const [a, b] = await Promise.all([deliver(app, body), deliver(other, body)]);
        expect([a.statusCode, b.statusCode]).toEqual([204, 204]);
        expect((await audit(ada.token, groupId)).filter(entry => entry.subjectId === id)).toHaveLength(1);
      } finally {
        await other.stop();
      }
    });

    it('keeps the entry of a change answered as done when the server is killed right after it', async () => {
      const path = temporaryDatabasePath();
      const first = await startServerProcess(path);
      const json = { 'content-type': 'application/json' };
      let token = '';
      let groupId = '';
      let expenseId = '';
      try {
        const account = await fetch(`${first.base}/accounts`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify(validSignup),
        });
        expect(account.status).toBe(201);
        const accountId = ((await account.json()) as { id: string }).id;
        const login = await fetch(`${first.base}/accounts/login`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ email: validSignup.email, password: validSignup.password }),
        });
        token = ((await login.json()) as { token: string }).token;
        const headers = { ...json, authorization: `Bearer ${token}` };
        const created = await fetch(`${first.base}/groups`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'Flat', currency: 'EUR' }),
        });
        groupId = ((await created.json()) as { id: string }).id;
        const recorded = await fetch(`${first.base}/groups/${groupId}/expenses`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ description: 'Dinner', amount: 900, date: todayInUtc(), splitBetween: [accountId] }),
        });
        expect(recorded.status).toBe(201);
        expenseId = ((await recorded.json()) as { id: string }).id;
      } finally {
        // Killed as soon as the expense is answered: nothing is closed, nothing is flushed by the server.
        first.child.kill('SIGKILL');
        await exited(first.child);
      }

      const second = await startServerProcess(path);
      try {
        const response = await fetch(`${second.base}/groups/${groupId}/audit`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const entries = (await response.json()) as Entry[];
        expect(entries.map(entry => [entry.action, entry.subjectId])).toEqual([['expense-recorded', expenseId]]);
      } finally {
        second.child.kill('SIGTERM');
        await exited(second.child);
      }
    });
  });
});
