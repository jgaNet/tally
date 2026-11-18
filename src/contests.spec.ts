import { createHmac } from 'node:crypto';
import { Application } from './app';
import { ada, call, FakeProvider, startApplication, startFakeProvider, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };
const administrator = { email: 'admin@example.com', password: 'administer-2026', name: 'Administrator' };

const PAST_DAY = '2026-11-01';
// The provider's id of Ada's payout account.
const adaPayout = 'acct_ada';
const SECRET = 'whsec_test';
const AT = '2026-11-20T10:00:00Z';

describe('contesting a settlement paid through the payment provider', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let provider: FakeProvider;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let outsiderToken: string;
  let adminId: string;
  let adminToken: string;
  let groupId: string;

  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  const askProvider = (body: unknown, token: string) =>
    call(app, 'POST', `/groups/${groupId}/settlements/provider`, { body, token });

  const contest = (settlementId: string, token: string) =>
    call(app, 'POST', `/settlements/${settlementId}/contest`, { token });

  const decision = (settlementId: string, paid: boolean, token = adminToken) =>
    call(app, 'POST', `/admin/settlements/${settlementId}/decision`, { body: { paid }, token });

  const balancesOf = async (): Promise<Record<string, number>> =>
    Object.fromEntries(
      (await call(app, 'GET', `/groups/${groupId}/balances`, { token: adaToken })).body.map(
        (row: { memberId: string; balance: number }) => [row.memberId, row.balance],
      ),
    );

  const suggestedOf = async () =>
    (await call(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: adaToken })).body;

  const auditOf = async () =>
    (await call(app, 'GET', `/groups/${groupId}/audit`, { token: adaToken })).body as Array<{
      action: string;
      by: string;
      subjectId: string;
      amount: number;
    }>;

  /** The webhook body, as the provider sends it, and its signature. */
  function signed(event: Record<string, unknown>): { raw: string; signature: string } {
    const raw = JSON.stringify(event);
    return { raw, signature: createHmac('sha256', SECRET).update(raw).digest('hex') };
  }

  const decide = (paymentId: string, status: string, id = `wh_${paymentId}_${status}`) => {
    const { raw, signature } = signed({ id, paymentId, status, at: AT });
    return call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  };

  const settlementOf = async (settlementId: string, token = adaToken) =>
    (await call(app, 'GET', `/settlements/${settlementId}`, { token })).body;

  /** The balances once the settlement of 1000 from Grace to Ada is paid, and before it is. */
  const paidBalances = (): Record<string, number> => ({ [adaId]: 1000, [graceId]: 0, [linusId]: -1000 });
  const unpaidBalances = (): Record<string, number> => ({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });

  /** Grace asks to pay Ada 1000 through the provider, and the provider says it succeeded: payment `pay_1`. */
  async function paidSettlement(): Promise<string> {
    const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
    expect(answer.status).toBe(201);
    expect((await decide('pay_1', 'succeeded')).status).toBe(204);
    return answer.body.id;
  }

  /** A paid settlement, contested by its payee: the balances are those before it was paid. */
  async function contestedSettlement(): Promise<string> {
    const settlement = await paidSettlement();
    expect((await contest(settlement, adaToken)).status).toBe(204);
    return settlement;
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, {
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      adminEmails: [administrator.email],
    });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    // Ada is paid through the provider, on her payout account. Setting it asks the provider, which is not a payment.
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: adaPayout }, token: adaToken }))
        .status,
    ).toBe(204);
    provider.requests.splice(0);
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    ({ token: outsiderToken } = await accountOf(outsiderAccount));
    ({ id: adminId, token: adminToken } = await accountOf(administrator));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
    // Ada paid 3000, split equally between the three: Ada is owed 2000, Grace and Linus each owe 1000.
    const expense = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: {
        description: 'Dinner',
        amount: 3000,
        date: PAST_DAY,
        splitExactly: [
          { memberId: adaId, amount: 1000 },
          { memberId: graceId, amount: 1000 },
          { memberId: linusId, amount: 1000 },
        ],
      },
      token: adaToken,
    });
    expect(expense.status).toBe(201);
  });

  afterEach(async () => {
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  describe('the contest', () => {
    it('is made by the payee of a paid settlement, which is then contested and held: the balances are as before it was paid', async () => {
      const settlement = await paidSettlement();
      expect(await balancesOf()).toEqual(paidBalances());

      expect((await contest(settlement, adaToken)).status).toBe(204);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'contested', amount: 1000, method: 'provider' });
      expect((await settlementOf(settlement)).history.map((entry: { status: string }) => entry.status)).toEqual([
        'pending',
        'paid',
        'contested',
      ]);
      expect(await balancesOf()).toEqual(unpaidBalances());
    });

    it('still counts it as paid for what is owed: the transfers that settle the group leave it out', async () => {
      await contestedSettlement();
      // Grace still owes nothing once the payment is counted, and Ada is owed 1000 more, so Linus pays the rest.
      expect(await suggestedOf()).toEqual([{ from: linusId, to: adaId, amount: 1000 }]);
      // Grace owes nothing that can be paid now: the payment waiting for her is counted as paid.
      expect((await askProvider({ to: adaId, amount: 1 }, graceToken)).body).toMatchObject({
        type: 'AmountTooLarge',
      });
    });

    it('is audited as settlement-contested, by its payee, with its amount', async () => {
      const settlement = await contestedSettlement();
      expect(await auditOf()).toContainEqual({
        action: 'settlement-contested',
        by: adaId,
        subjectId: settlement,
        amount: 1000,
        at: expect.any(String),
        id: expect.any(String),
      });
    });

    it('is refused to anyone who is not its payee, and nothing changes', async () => {
      const settlement = await paidSettlement();
      const payer = await contest(settlement, graceToken);
      expect(payer.status).toBe(403);
      expect(payer.body.type).toBe('NotAllowed');
      const otherMember = await contest(settlement, linusToken);
      expect(otherMember.status).toBe(403);
      expect(otherMember.body.type).toBe('NotAllowed');
      // Anyone who is not a member does not see the settlement at all.
      expect((await contest(settlement, outsiderToken)).status).toBe(404);
      expect((await settlementOf(settlement)).status).toBe('paid');
      expect(await balancesOf()).toEqual(paidBalances());
    });

    it('is made once for a settlement: one decided as paid again cannot be contested again', async () => {
      const settlement = await contestedSettlement();
      expect((await decision(settlement, true)).status).toBe(204);
      const again = await contest(settlement, adaToken);
      expect(again.status).toBe(409);
      expect(again.body.type).toBe('AlreadyContested');
      expect((await settlementOf(settlement)).status).toBe('paid');
    });

    it('is refused for a settlement that is not a paid one through the provider, and nothing changes', async () => {
      // A cash settlement, recorded by its payee.
      const cash = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from: linusId, amount: 1000 },
        token: adaToken,
      });
      expect(cash.status).toBe(201);
      const refused = await contest(cash.body.id, adaToken);
      expect(refused.status).toBe(409);
      expect(refused.body.type).toBe('NotContestable');

      // A payment the provider has not decided yet is pending, and not contested.
      // Grace still owes 1000, as the cash settlement was Linus's.
      const pending = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect(pending.status).toBe(201);
      expect((await contest(pending.body.id, adaToken)).body.type).toBe('NotContestable');
      expect((await settlementOf(pending.body.id)).status).toBe('pending');
      expect((await settlementOf(cash.body.id)).status).toBe('paid');
    });

    it('is refused once the payer has left the group, and nothing changes', async () => {
      const settlement = await paidSettlement();
      // Grace owes nothing once the payment counts, so she may leave the group.
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken })).status).toBe(204);
      const refused = await contest(settlement, adaToken);
      expect(refused.status).toBe(409);
      expect(refused.body.type).toBe('NotContestable');
      expect((await settlementOf(settlement)).status).toBe('paid');
    });

    it('holds the payer in the group while it is contested: the payer may not leave', async () => {
      await contestedSettlement();
      const leave = await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken });
      expect(leave.status).toBe(409);
      expect(leave.body.type).toBe('SettlementWaiting');
    });

    it('holds the group in place while it is contested: the group is not merged away', async () => {
      await contestedSettlement();
      const otherGroup = (
        await call(app, 'POST', '/groups', { body: { name: 'The other flat', currency: 'EUR' }, token: adaToken })
      ).body.id;
      const merge = await call(app, 'POST', `/groups/${otherGroup}/merge`, {
        body: { from: groupId },
        token: adaToken,
      });
      expect(merge.status).toBe(409);
      expect(merge.body.type).toBe('SettlementWaiting');
    });

    it('is not changed by a webhook about its payment, whatever the webhook says', async () => {
      const settlement = await contestedSettlement();
      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      expect((await decide('pay_1', 'failed')).status).toBe(204);
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'contested' });
      expect(await balancesOf()).toEqual(unpaidBalances());
    });

    it('is not refunded while it is contested', async () => {
      const settlement = await contestedSettlement();
      const refund = await call(app, 'POST', `/settlements/${settlement}/refund`, { token: adaToken });
      expect(refund.status).toBe(409);
      expect(refund.body.type).toBe('NotRefundable');
      expect(provider.requests.some(request => request.path.endsWith('/refunds'))).toBe(false);
    });
  });

  describe('the decision of an administrator', () => {
    it('paid: the settlement is paid again, counted as it was before it was contested, and audited by the administrator', async () => {
      const settlement = await contestedSettlement();
      expect((await decision(settlement, true)).status).toBe(204);

      expect(await settlementOf(settlement)).toMatchObject({ status: 'paid' });
      expect((await settlementOf(settlement)).history.map((entry: { status: string }) => entry.status)).toEqual([
        'pending',
        'paid',
        'contested',
        'paid',
      ]);
      expect(await balancesOf()).toEqual(paidBalances());
      const audit = await auditOf();
      expect(audit.map(entry => entry.action)).toEqual([
        'expense-recorded',
        'settlement-paid',
        'settlement-contested',
        'settlement-paid',
      ]);
      const administratorsPaid = audit[3];
      expect(administratorsPaid).toMatchObject({ by: adminId, subjectId: settlement, amount: 1000 });
    });

    it('not paid: the settlement is annulled, nothing counts it, and what was owed is owed again', async () => {
      const settlement = await contestedSettlement();
      expect((await decision(settlement, false)).status).toBe(204);

      expect(await settlementOf(settlement)).toMatchObject({ status: 'annulled' });
      expect((await settlementOf(settlement)).history.map((entry: { status: string }) => entry.status)).toEqual([
        'pending',
        'paid',
        'contested',
        'annulled',
      ]);
      expect(await balancesOf()).toEqual(unpaidBalances());
      expect(await suggestedOf()).toEqual([
        { from: graceId, to: adaId, amount: 1000 },
        { from: linusId, to: adaId, amount: 1000 },
      ]);
      // An annulled settlement is no entry of the audit: only its contest is.
      expect((await auditOf()).map(entry => entry.action)).toEqual([
        'expense-recorded',
        'settlement-paid',
        'settlement-contested',
      ]);
    });

    it('decides a contested settlement once: a second decision is refused and changes nothing', async () => {
      const settlement = await contestedSettlement();
      expect((await decision(settlement, false)).status).toBe(204);
      const again = await decision(settlement, true);
      expect(again.status).toBe(409);
      expect(again.body.type).toBe('NotContested');
      expect(await settlementOf(settlement)).toMatchObject({ status: 'annulled' });
    });
  });
});
