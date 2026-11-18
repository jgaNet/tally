import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Application } from './app';
import { ada, call, FakeProvider, startApplication, startFakeProvider, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';
const SECRET = 'whsec_test';
const AT = '2026-11-20T10:00:00Z';
const adaPayout = 'acct_ada';
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

/** The rows of the audit table, read apart from the application, as the file keeps them. */
function auditRows(path: string): Array<Record<string, unknown>> {
  const probe = new DatabaseSync(path);
  try {
    return probe.prepare('SELECT * FROM audit_entries ORDER BY seq').all() as Array<Record<string, unknown>>;
  } finally {
    probe.close();
  }
}

describe('the audit of a group', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let provider: FakeProvider;
  let app: Application;
  const extraApps: Application[] = [];
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let outsiderToken: string;
  let groupId: string;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  /** Brings the account into the group by an invitation of the owner, and accepts it. */
  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  /** Records an expense of the group, paid by the account that signs the request with `token`. */
  async function record(token: string, fields: Record<string, unknown>): Promise<string> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', date: PAST_DAY, ...fields },
      token,
    });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  const audit = (token = adaToken, using: Application = app) =>
    call(using, 'GET', `/groups/${groupId}/audit`, { token });

  /** The webhook of the provider about a payment, signed as the provider signs it. */
  const decide = (paymentId: string, status: string, using: Application = app) => {
    const raw = JSON.stringify({ id: `wh_${paymentId}_${status}`, paymentId, status, at: AT });
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    return call(using, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  };

  /** The entries of the audit, as the API answers them. */
  async function entriesOf(token = adaToken): Promise<Array<Record<string, unknown>>> {
    const answer = await audit(token);
    expect(answer.status).toBe(200);
    return answer.body;
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.path, { providerUrl: provider.url, providerWebhookSecret: SECRET });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: adaPayout }, token: adaToken }))
        .status,
    ).toBe(204);
    provider.requests.splice(0);
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    outsiderToken = (await accountOf(outsiderAccount)).token;
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
  });

  afterEach(async () => {
    for (const extra of extraApps.splice(0)) await extra.stop();
    await app.stop();
    await provider.stop();
    database.remove();
  });

  describe('expenses', () => {
    it('writes an entry for an expense recorded, by its payer, with its amount', async () => {
      const expense = await record(graceToken, { amount: 3000, splitBetween: [adaId, graceId, linusId] });
      expect(await entriesOf()).toEqual([
        {
          id: expect.any(String),
          at: expect.stringMatching(AT_PATTERN),
          by: graceId,
          action: 'expense-recorded',
          subjectId: expense,
          amount: 3000,
        },
      ]);
    });

    it('writes an entry for an expense edited, by who edited it, with the amount after the edit', async () => {
      const expense = await record(graceToken, { amount: 9000, splitBetween: [adaId, graceId, linusId] });
      const edit = await call(app, 'PUT', `/expenses/${expense}`, {
        body: {
          description: 'Dinner',
          date: PAST_DAY,
          amount: 6000,
          splitBetween: [adaId, graceId, linusId],
          version: 1,
        },
        token: adaToken,
      });
      expect(edit.status).toBe(204);
      const entries = await entriesOf();
      expect(entries.map(entry => [entry.by, entry.action, entry.subjectId, entry.amount])).toEqual([
        [graceId, 'expense-recorded', expense, 9000],
        [adaId, 'expense-edited', expense, 6000],
      ]);
    });

    it('writes no entry for an edit refused, as one from a version already changed', async () => {
      const expense = await record(graceToken, { amount: 9000, splitBetween: [adaId, graceId, linusId] });
      await call(app, 'PUT', `/expenses/${expense}`, {
        body: {
          description: 'Dinner',
          date: PAST_DAY,
          amount: 6000,
          splitBetween: [adaId, graceId, linusId],
          version: 1,
        },
        token: adaToken,
      });
      const stale = await call(app, 'PUT', `/expenses/${expense}`, {
        body: {
          description: 'Dinner',
          date: PAST_DAY,
          amount: 1000,
          splitBetween: [adaId, graceId, linusId],
          version: 1,
        },
        token: graceToken,
      });
      expect(stale.status).toBe(409);
      expect((await entriesOf()).map(entry => entry.action)).toEqual(['expense-recorded', 'expense-edited']);
    });

    it('writes no entry for an expense refused when recorded', async () => {
      const refused = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: { description: 'Dinner', date: PAST_DAY, amount: 3000, splitBetween: [graceId, linusId] },
        token: adaToken,
      });
      expect(refused.status).toBe(422);
      expect(await entriesOf()).toEqual([]);
    });

    it('writes an entry for an expense deleted, by who deleted it, with the amount it had, and keeps the entries', async () => {
      const expense = await record(graceToken, { amount: 3000, splitBetween: [adaId, graceId, linusId] });
      expect((await call(app, 'DELETE', `/expenses/${expense}`, { token: graceToken })).status).toBe(204);
      const entries = await entriesOf();
      expect(entries.map(entry => [entry.by, entry.action, entry.subjectId, entry.amount])).toEqual([
        [graceId, 'expense-recorded', expense, 3000],
        [graceId, 'expense-deleted', expense, 3000],
      ]);
    });

    it('writes an entry for each expense a recurring expense records, by its payer', async () => {
      const created = await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Rent', amount: 1001, startsOn: PAST_DAY, splitBetween: [adaId, graceId] },
        token: adaToken,
      });
      expect(created.status).toBe(201);
      app.runJobs(new Date('2026-11-18T12:00:00Z'));
      const expenses = (await call(app, 'GET', `/groups/${groupId}/expenses`, { token: adaToken })).body;
      expect(expenses).toHaveLength(1);
      expect(await entriesOf()).toEqual([
        {
          id: expect.any(String),
          at: '2026-11-18T12:00:00.000Z',
          by: adaId,
          action: 'expense-recorded',
          subjectId: expenses[0].id,
          amount: 1001,
        },
      ]);
    });

    it('writes no entry for a recurring expense set up', async () => {
      await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Rent', amount: 1001, startsOn: '2026-12-01', splitBetween: [adaId, graceId] },
        token: adaToken,
      });
      expect(await entriesOf()).toEqual([]);
    });
  });

  describe('settlements', () => {
    /** Ada paid 3000 split equally between the three of them, so Grace owes 1000 and Ada is owed 2000. */
    const dinner = () => record(adaToken, { amount: 3000, splitBetween: [adaId, graceId, linusId] });

    it('writes an entry for a cash settlement recorded, by its payee', async () => {
      await dinner();
      const answer = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from: graceId, amount: 1000 },
        token: adaToken,
      });
      expect(answer.status).toBe(201);
      expect((await entriesOf()).slice(1)).toEqual([
        {
          id: expect.any(String),
          at: expect.stringMatching(AT_PATTERN),
          by: adaId,
          action: 'settlement-paid',
          subjectId: answer.body.id,
          amount: 1000,
        },
      ]);
    });

    it('writes an entry for a settlement through the provider when the provider says it succeeded, by its payer, once', async () => {
      await dinner();
      const asked = await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: adaId, amount: 1000 },
        token: graceToken,
      });
      expect(asked.status).toBe(201);
      // Pending: nothing is counted yet, so nothing is audited.
      expect((await entriesOf()).map(entry => entry.action)).toEqual(['expense-recorded']);

      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      expect((await decide('pay_1', 'succeeded', app)).status).toBe(204);
      const entries = await entriesOf();
      expect(entries.slice(1).map(entry => [entry.by, entry.action, entry.subjectId, entry.amount])).toEqual([
        [graceId, 'settlement-paid', asked.body.id, 1000],
      ]);
      expect(auditRows(database.path)).toHaveLength(2);
    });

    it('writes no entry for a payment the provider says failed', async () => {
      await dinner();
      await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: adaId, amount: 1000 },
        token: graceToken,
      });
      expect((await decide('pay_1', 'failed')).status).toBe(204);
      expect((await entriesOf()).map(entry => entry.action)).toEqual(['expense-recorded']);
    });

    it('writes an entry for a refund once the provider says it is refunded, by its payee, and none while refunding', async () => {
      await dinner();
      const asked = await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: adaId, amount: 1000 },
        token: graceToken,
      });
      await decide('pay_1', 'succeeded');

      expect((await call(app, 'POST', `/settlements/${asked.body.id}/refund`, { token: adaToken })).status).toBe(204);
      expect((await entriesOf()).map(entry => entry.action)).toEqual(['expense-recorded', 'settlement-paid']);

      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      const entries = await entriesOf();
      expect(entries.slice(2).map(entry => [entry.by, entry.action, entry.subjectId, entry.amount])).toEqual([
        [adaId, 'settlement-refunded', asked.body.id, 1000],
      ]);
    });

    it('writes no entry for a payment that is refunded before the provider says it succeeded', async () => {
      await dinner();
      await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: adaId, amount: 1000 },
        token: graceToken,
      });
      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      expect((await entriesOf()).map(entry => entry.action)).toEqual(['expense-recorded']);
    });
  });

  describe('leaving with a balance', () => {
    it('writes an entry for the balance passed to the owner, by the member who left, with it as they left', async () => {
      // Ada paid 3000 split equally: Grace owes 1000, which passes to Ada when Grace leaves.
      await record(adaToken, { amount: 3000, splitBetween: [adaId, graceId, linusId] });
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken })).status).toBe(204);
      const entries = await entriesOf();
      expect(entries.slice(1)).toEqual([
        {
          id: expect.any(String),
          at: expect.stringMatching(AT_PATTERN),
          by: graceId,
          action: 'balance-passed',
          subjectId: graceId,
          amount: -1000,
        },
      ]);
    });

    it('writes no entry for a member who leaves at a balance of 0', async () => {
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: linusToken })).status).toBe(204);
      expect(await entriesOf()).toEqual([]);
    });
  });

  describe('reading it', () => {
    it('answers a member the entries the oldest first, and keeps them after the member leaves', async () => {
      const expense = await record(graceToken, { amount: 3000, splitBetween: [adaId, graceId, linusId] });
      await call(app, 'DELETE', `/expenses/${expense}`, { token: graceToken });
      await call(app, 'POST', `/groups/${groupId}/leave`, { token: linusToken });
      expect((await entriesOf(adaToken)).map(entry => entry.action)).toEqual(['expense-recorded', 'expense-deleted']);
      // Grace reads the group's audit as a member; Linus, who left, no longer reads it.
      expect((await audit(graceToken)).status).toBe(200);
      expect((await audit(linusToken)).status).toBe(404);
    });

    it('answers the entries of a member as the same list, whatever the member', async () => {
      await record(graceToken, { amount: 3000, splitBetween: [adaId, graceId, linusId] });
      expect(await entriesOf(graceToken)).toEqual(await entriesOf(adaToken));
    });

    it('says a group does not exist for anyone who is not a member of it, and asks for a sign in', async () => {
      expect(await audit(outsiderToken)).toEqual({
        status: 404,
        body: { type: 'NotFound', message: expect.any(String) },
      });
      expect((await call(app, 'GET', `/groups/${groupId}/audit`)).status).toBe(401);
    });

    it('writes an entry exactly once when two servers on the database are told at once', async () => {
      const second = await startApplication(database.path, {
        providerUrl: provider.url,
        providerWebhookSecret: SECRET,
      });
      extraApps.push(second);
      await record(adaToken, { amount: 3000, splitBetween: [adaId, graceId, linusId] });
      const asked = await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: adaId, amount: 1000 },
        token: graceToken,
      });
      expect(asked.status).toBe(201);
      await Promise.all([decide('pay_1', 'succeeded', app), decide('pay_1', 'succeeded', second)]);
      expect(auditRows(database.path).filter(row => row.action === 'settlement-paid')).toHaveLength(1);
    });
  });
});
