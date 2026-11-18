import { createHmac } from 'node:crypto';
import { Application } from './app';
import {
  ada,
  call,
  countRows,
  FakeProvider,
  startApplication,
  startFakeProvider,
  temporaryDatabase,
} from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const administrator = { email: 'admin@example.com', password: 'administer-2026', name: 'Administrator' };
const notAdministrator = { email: 'notadmin@example.com', password: 'not-an-admin', name: 'Not An Admin' };

const PAST_DAY = '2026-11-01';
// The provider's ids of Ada's and Grace's payout accounts.
const adaPayout = 'acct_ada';
const gracePayout = 'acct_grace';
const SECRET = 'whsec_test';
const AT = '2026-11-20T10:00:00Z';
// The day the background job runs, and the day recurring expenses started, a few months before it.
const NOW = new Date('2026-11-18T12:00:00Z');
const STARTED_ON = '2026-09-05';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe('suspending an account', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let provider: FakeProvider;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let adminId: string;
  let adminToken: string;
  let notAdminToken: string;
  let groupId: string;

  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  async function join(accountToken: string, group: string, inviterToken = adaToken): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${group}/invitations`, { token: inviterToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  const suspend = (accountId: string, token = adminToken) =>
    call(app, 'PUT', `/admin/accounts/${accountId}/suspension`, { token });
  const reinstate = (accountId: string, token = adminToken) =>
    call(app, 'DELETE', `/admin/accounts/${accountId}/suspension`, { token });
  const log = (token = adminToken) => call(app, 'GET', '/admin/log', { token });

  /** Everything a group holds, as its owner reads it. A suspension must leave all of it as it was. */
  async function groupState(group = groupId) {
    const read = async (path: string) => (await call(app, 'GET', `/groups/${group}${path}`, { token: adaToken })).body;
    return {
      members: await read('/members'),
      balances: await read('/balances'),
      expenses: await read('/expenses'),
      settlements: await read('/settlements'),
      audit: await read('/audit'),
    };
  }

  /** The counts of what the writes a suspended account is refused would have added. */
  async function writeCounts(): Promise<Record<string, number>> {
    const tables = ['expenses', 'recurring', 'settlements', 'nettings', 'admin_log', 'suspensions'];
    return Object.fromEntries(
      await Promise.all(tables.map(async table => [table, await countRows(database.url, table)] as const)),
    );
  }

  const expenseOf = (paidBy: string, amount: number) => ({
    description: 'Dinner',
    amount,
    date: PAST_DAY,
    splitExactly: [
      { memberId: paidBy, amount: amount / 2 },
      { memberId: paidBy === adaId ? graceId : adaId, amount: amount / 2 },
    ],
  });

  const decide = (paymentId: string, status: string) => {
    const raw = JSON.stringify({ id: `wh_${paymentId}_${status}`, paymentId, status, at: AT });
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    return call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  };

  /**
   * A group of Ada and Grace, where Grace paid 1000 split equally: Ada owes Grace 500. Grace's payout account is at the
   * provider. Returns the group's id.
   */
  async function graceIsOwed(): Promise<string> {
    const group = (
      await call(app, 'POST', '/groups', { body: { name: 'The trip', currency: 'EUR' }, token: graceToken })
    ).body.id;
    await join(adaToken, group, graceToken);
    const paid = await call(app, 'POST', `/groups/${group}/expenses`, {
      body: {
        description: 'Train',
        amount: 1000,
        date: PAST_DAY,
        splitExactly: [
          { memberId: graceId, amount: 500 },
          { memberId: adaId, amount: 500 },
        ],
      },
      token: graceToken,
    });
    expect(paid.status).toBe(201);
    return group;
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, {
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      adminEmails: ['Admin@example.com'],
    });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    ({ id: adminId, token: adminToken } = await accountOf(administrator));
    ({ token: notAdminToken } = await accountOf(notAdministrator));
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: adaPayout }, token: adaToken }))
        .status,
    ).toBe(204);
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: gracePayout }, token: graceToken }))
        .status,
    ).toBe(204);
    provider.requests.splice(0);
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken, groupId);
    await join(linusToken, groupId);
    // Ada paid 1000 for Dinner: Ada is owed 600, Grace and Linus each owe 300.
    const dinner = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: {
        description: 'Dinner',
        amount: 1000,
        date: PAST_DAY,
        splitExactly: [
          { memberId: adaId, amount: 400 },
          { memberId: graceId, amount: 300 },
          { memberId: linusId, amount: 300 },
        ],
      },
      token: adaToken,
    });
    expect(dinner.status).toBe(201);
  });

  afterEach(async () => {
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  describe('the administrators suspend and reinstate accounts', () => {
    it('suspends an account and reinstates it, each logged, and writes nothing in any group', async () => {
      const before = await groupState();
      expect((await suspend(graceId)).status).toBe(204);
      expect(await groupState()).toEqual(before);
      expect((await log()).body).toEqual([
        {
          id: expect.any(String),
          at: expect.stringMatching(ISO),
          by: adminId,
          action: 'suspended',
          subjectId: graceId,
        },
      ]);

      expect((await reinstate(graceId)).status).toBe(204);
      expect(await groupState()).toEqual(before);
      expect((await log()).body).toEqual([
        expect.objectContaining({ by: adminId, action: 'suspended', subjectId: graceId }),
        expect.objectContaining({ by: adminId, action: 'reinstated', subjectId: graceId }),
      ]);
    });

    it('changes nothing, and writes no entry, when the account is suspended already or not suspended', async () => {
      expect((await reinstate(graceId)).status).toBe(204);
      expect((await log()).body).toEqual([]);

      expect((await suspend(graceId)).status).toBe(204);
      expect((await suspend(graceId)).status).toBe(204);
      expect((await log()).body).toHaveLength(1);

      expect((await reinstate(graceId)).status).toBe(204);
      expect((await reinstate(graceId)).status).toBe(204);
      expect((await log()).body).toHaveLength(2);
    });

    it('is refused to anyone who is not an administrator, and changes nothing', async () => {
      const before = await writeCounts();
      expect(await suspend(graceId, adaToken)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
      expect(await suspend(graceId, notAdminToken)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
      expect(await suspend(graceId, graceToken)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
      expect(await call(app, 'PUT', `/admin/accounts/${graceId}/suspension`)).toMatchObject({ status: 401 });
      expect(await writeCounts()).toEqual(before);
    });

    it('is refused reinstating by anyone who is not an administrator, and the account stays suspended', async () => {
      expect((await suspend(graceId)).status).toBe(204);
      expect(await reinstate(graceId, notAdminToken)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
      expect(await reinstate(graceId, adaToken)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
      expect((await log()).body).toHaveLength(1);
      expect(
        (await call(app, 'POST', `/groups/${groupId}/expenses`, { body: expenseOf(graceId, 200), token: graceToken }))
          .body,
      ).toEqual({ type: 'AccountSuspended', message: expect.any(String) });
    });

    it('answers NotFound for an account that does not exist, and changes nothing', async () => {
      const before = await writeCounts();
      expect(await suspend('no-such-account')).toMatchObject({ status: 404, body: { type: 'NotFound' } });
      expect(await reinstate('no-such-account')).toMatchObject({ status: 404, body: { type: 'NotFound' } });
      expect(await writeCounts()).toEqual(before);
    });

    it('keeps the log to administrators, who see the actions as they are', async () => {
      expect((await suspend(graceId)).status).toBe(204);
      expect(await log(notAdminToken)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
      expect((await log()).body[0]).toMatchObject({ action: 'suspended', subjectId: graceId });
    });
  });

  describe('what a suspended account cannot do', () => {
    beforeEach(async () => {
      expect((await suspend(graceId)).status).toBe(204);
    });

    it('cannot record an expense, in any group', async () => {
      const before = await groupState();
      const counts = await writeCounts();
      const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: expenseOf(graceId, 200),
        token: graceToken,
      });
      expect(answer).toMatchObject({ status: 403, body: { type: 'AccountSuspended', message: expect.any(String) } });
      expect(await groupState()).toEqual(before);
      expect(await writeCounts()).toEqual(counts);
    });

    it('cannot set up a recurring expense', async () => {
      const counts = await writeCounts();
      const answer = await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Rent', amount: 1001, startsOn: STARTED_ON, splitBetween: [adaId, graceId] },
        token: graceToken,
      });
      expect(answer).toMatchObject({ status: 403, body: { type: 'AccountSuspended' } });
      expect(await writeCounts()).toEqual(counts);
    });

    it('cannot record a settlement in cash', async () => {
      const before = await groupState();
      const counts = await writeCounts();
      const answer = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from: adaId, amount: 100 },
        token: graceToken,
      });
      expect(answer).toMatchObject({ status: 403, body: { type: 'AccountSuspended' } });
      expect(await groupState()).toEqual(before);
      expect(await writeCounts()).toEqual(counts);
    });

    it('cannot ask to pay through the provider, and the provider is not asked', async () => {
      const before = await groupState();
      const counts = await writeCounts();
      const answer = await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: adaId, amount: 100 },
        token: graceToken,
      });
      expect(answer).toMatchObject({ status: 403, body: { type: 'AccountSuspended' } });
      expect(provider.requests).toEqual([]);
      expect(await groupState()).toEqual(before);
      expect(await writeCounts()).toEqual(counts);
    });

    it('cannot ask for a netting', async () => {
      const counts = await writeCounts();
      const answer = await call(app, 'POST', '/nettings', {
        body: { with: adaId, currency: 'EUR' },
        token: graceToken,
      });
      expect(answer).toMatchObject({ status: 403, body: { type: 'AccountSuspended' } });
      expect(await writeCounts()).toEqual(counts);
    });

    it('is refused in every group it is in, the same way', async () => {
      const other = (
        await call(app, 'POST', '/groups', { body: { name: 'The office', currency: 'EUR' }, token: adaToken })
      ).body.id;
      await join(graceToken, other);
      const answer = await call(app, 'POST', `/groups/${other}/expenses`, {
        body: expenseOf(graceId, 200),
        token: graceToken,
      });
      expect(answer.body.type).toBe('AccountSuspended');
    });
  });

  describe('what a suspended account still can do', () => {
    it('signs in, and reads its account and its groups', async () => {
      expect((await suspend(graceId)).status).toBe(204);
      const token = (await call(app, 'POST', '/accounts/login', { body: grace })).body.token;
      expect((await call(app, 'GET', '/accounts/me', { token })).body).toMatchObject({ id: graceId });
      expect((await call(app, 'GET', '/groups/mine', { token })).body).toEqual([
        expect.objectContaining({ id: groupId }),
      ]);
      expect((await call(app, 'GET', `/groups/${groupId}/balances`, { token })).status).toBe(200);
    });

    it('edits and deletes an expense it paid, and it stays recorded as before', async () => {
      const recorded = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: expenseOf(graceId, 200),
        token: graceToken,
      });
      expect(recorded.status).toBe(201);
      expect((await suspend(graceId)).status).toBe(204);
      const expense = (await call(app, 'GET', `/expenses/${recorded.body.id}`, { token: graceToken })).body;
      const edited = await call(app, 'PUT', `/expenses/${recorded.body.id}`, {
        body: { ...expenseOf(graceId, 200), description: 'Lunch', version: expense.version },
        token: graceToken,
      });
      expect(edited.status).toBe(204);
      expect((await call(app, 'GET', `/expenses/${recorded.body.id}`, { token: graceToken })).body.description).toBe(
        'Lunch',
      );
      expect((await call(app, 'DELETE', `/expenses/${recorded.body.id}`, { token: graceToken })).status).toBe(204);
      expect((await call(app, 'GET', `/expenses/${recorded.body.id}`, { token: graceToken })).status).toBe(404);
    });

    it('leaves a group, once its balance is 0', async () => {
      const otherGroup = (
        await call(app, 'POST', '/groups', { body: { name: 'The office', currency: 'EUR' }, token: adaToken })
      ).body.id;
      await join(graceToken, otherGroup);
      expect((await suspend(graceId)).status).toBe(204);
      expect((await call(app, 'POST', `/groups/${otherGroup}/leave`, { token: graceToken })).status).toBe(204);
    });

    it('contests a settlement paid to it through the provider', async () => {
      const group = await graceIsOwed();
      const asked = await call(app, 'POST', `/groups/${group}/settlements/provider`, {
        body: { to: graceId, amount: 500 },
        token: adaToken,
      });
      expect(asked.status).toBe(201);
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      expect((await suspend(graceId)).status).toBe(204);
      const contested = await call(app, 'POST', `/settlements/${asked.body.id}/contest`, { token: graceToken });
      expect(contested.status).toBe(204);
    });
  });

  describe('what the others of its groups still can do', () => {
    it('is still put in a split of an expense', async () => {
      expect((await suspend(graceId)).status).toBe(204);
      const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: {
          description: 'Taxi',
          amount: 600,
          date: PAST_DAY,
          splitExactly: [
            { memberId: adaId, amount: 300 },
            { memberId: graceId, amount: 300 },
          ],
        },
        token: adaToken,
      });
      expect(answer.status).toBe(201);
    });

    it('has its payment to a member recorded in cash', async () => {
      expect((await suspend(graceId)).status).toBe(204);
      const answer = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from: graceId, amount: 300 },
        token: adaToken,
      });
      expect(answer.status).toBe(201);
    });

    it('is paid through the provider by a member', async () => {
      const group = await graceIsOwed();
      expect((await suspend(graceId)).status).toBe(204);
      const asked = await call(app, 'POST', `/groups/${group}/settlements/provider`, {
        body: { to: graceId, amount: 500 },
        token: adaToken,
      });
      expect(asked.status).toBe(201);
      expect(provider.requests).toHaveLength(1);
    });
  });

  describe('the background job and the recurring expenses of a suspended payer', () => {
    it('records nothing for a suspended payer, whose days wait until it is reinstated', async () => {
      const graces = await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Rent', amount: 1001, startsOn: STARTED_ON, splitBetween: [adaId, graceId] },
        token: graceToken,
      });
      expect(graces.status).toBe(201);
      const adas = await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Internet', amount: 600, startsOn: STARTED_ON, splitBetween: [adaId, graceId] },
        token: adaToken,
      });
      expect(adas.status).toBe(201);

      expect((await suspend(graceId)).status).toBe(204);
      await app.runJobs(NOW);
      const during = await call(app, 'GET', `/groups/${groupId}/recurring`, { token: adaToken });
      expect(during.body.find((r: { id: string }) => r.id === graces.body.id)).toMatchObject({ next: STARTED_ON });
      expect(during.body.find((r: { id: string }) => r.id === adas.body.id)).toMatchObject({ next: '2026-12-05' });
      const recordedWhileSuspended = await call(app, 'GET', `/groups/${groupId}/expenses`, { token: adaToken });
      expect(recordedWhileSuspended.body.filter((e: { paidBy: string }) => e.paidBy === graceId)).toEqual([]);
      expect(recordedWhileSuspended.body.filter((e: { paidBy: string }) => e.paidBy === adaId)).toHaveLength(4);

      expect((await reinstate(graceId)).status).toBe(204);
      await app.runJobs(NOW);
      const after = await call(app, 'GET', `/groups/${groupId}/recurring`, { token: adaToken });
      expect(after.body.find((r: { id: string }) => r.id === graces.body.id)).toMatchObject({ next: '2026-12-05' });
      const recordedAfter = await call(app, 'GET', `/groups/${groupId}/expenses`, { token: adaToken });
      // The expenses are listed the latest first: the days recorded for Grace are compared in order.
      const datesOfGrace = recordedAfter.body
        .filter((e: { paidBy: string }) => e.paidBy === graceId)
        .map((e: { date: string }) => e.date)
        .sort();
      expect(datesOfGrace).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
    });
  });
});
