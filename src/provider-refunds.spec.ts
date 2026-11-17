import { createHmac } from 'node:crypto';
import { Application } from './app';
import {
  ada,
  Answer,
  call,
  FakeProvider,
  startApplication,
  startFakeProvider,
  temporaryDatabase,
} from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';
// The provider's id of Ada's payout account.
const adaPayout = 'acct_ada';
const SECRET = 'whsec_test';
const AT = '2026-11-20T10:00:00Z';

describe('refunding a settlement paid through the payment provider', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let provider: FakeProvider;
  const extraApps: Application[] = [];
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let outsiderToken: string;
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

  const refund = (settlementId: string, token: string, using: Application = app) =>
    call(using, 'POST', `/settlements/${settlementId}/refund`, { token });

  const balancesOf = async (): Promise<Record<string, number>> =>
    Object.fromEntries(
      (await call(app, 'GET', `/groups/${groupId}/balances`, { token: adaToken })).body.map(
        (row: { memberId: string; balance: number }) => [row.memberId, row.balance],
      ),
    );

  /** The webhook body, as the provider sends it, and its signature. */
  function signed(event: Record<string, unknown>): { raw: string; signature: string } {
    const raw = JSON.stringify(event);
    return { raw, signature: createHmac('sha256', SECRET).update(raw).digest('hex') };
  }

  const decide = (paymentId: string, status: string, id = `wh_${paymentId}_${status}`) => {
    const { raw, signature } = signed({ id, paymentId, status, at: AT });
    return call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  };

  const settlementOf = async (settlementId: string) =>
    (await call(app, 'GET', `/settlements/${settlementId}`, { token: graceToken })).body;

  /** The refunds the provider has been asked for, the earliest first. */
  const refundRequests = () => provider.requests.filter(request => request.path.endsWith('/refunds'));

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

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.path, { providerUrl: provider.url, providerWebhookSecret: SECRET });
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
    for (const extra of extraApps.splice(0)) await extra.stop();
    await app.stop();
    await provider.stop();
    database.remove();
  });

  describe('the refund and the states it leads to', () => {
    it('refunds a paid settlement through the provider, and the balances go back once the provider says it is refunded', async () => {
      const settlement = await paidSettlement();
      expect(await balancesOf()).toEqual(paidBalances());

      const answer = await refund(settlement, adaToken);
      expect(answer.status).toBe(204);
      expect(refundRequests()).toEqual([{ path: '/payments/pay_1/refunds', body: { reference: settlement } }]);
      // The money has not gone back yet: the settlement is refunding, and the balances still count it as paid.
      expect(await settlementOf(settlement)).toMatchObject({ status: 'refunding', amount: 1000, method: 'provider' });
      expect(await balancesOf()).toEqual(paidBalances());

      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'refunded' });
      expect(await balancesOf()).toEqual(unpaidBalances());
      const suggested = await call(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: adaToken });
      expect(suggested.body).toEqual([
        { from: graceId, to: adaId, amount: 1000 },
        { from: linusId, to: adaId, amount: 1000 },
      ]);
    });

    it('ends refunded when the provider says so while it is still answering the refund', async () => {
      const settlement = await paidSettlement();
      const webhook = new Promise<Answer>(resolve => {
        provider.answer = () => {
          resolve(decide('pay_1', 'refunded'));
          return { status: 201, body: { id: 'ref_1' }, delayMs: 200 };
        };
      });
      expect((await refund(settlement, adaToken)).status).toBe(204);
      expect((await webhook).status).toBe(204);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'refunded' });
      expect(await balancesOf()).toEqual(unpaidBalances());
    });
  });

  describe('who may refund', () => {
    it('refuses a refund by the payer, with 403, and asks the provider nothing', async () => {
      const settlement = await paidSettlement();
      const answer = await refund(settlement, graceToken);
      expect(answer).toEqual({ status: 403, body: { type: 'NotAllowed', message: expect.any(String) } });
      expect(refundRequests()).toEqual([]);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'paid' });
      expect(await balancesOf()).toEqual(paidBalances());
    });

    it('refuses a refund by another member of the group, with 403, and asks the provider nothing', async () => {
      const settlement = await paidSettlement();
      expect((await refund(settlement, linusToken)).status).toBe(403);
      expect(refundRequests()).toEqual([]);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'paid' });
    });

    it('answers 404 to an account outside the group, and changes nothing', async () => {
      const settlement = await paidSettlement();
      expect(await refund(settlement, outsiderToken)).toEqual({
        status: 404,
        body: { type: 'NotFound', message: expect.any(String) },
      });
      expect(refundRequests()).toEqual([]);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'paid' });
    });

    it('answers 404 for a settlement that does not exist', async () => {
      expect((await refund('no-such-settlement', adaToken)).status).toBe(404);
    });
  });

  describe('what can be refunded', () => {
    it('refuses a settlement in cash, with 409, as it is not refunded through Tally', async () => {
      const cash = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from: linusId, amount: 500 },
        token: adaToken,
      });
      expect(cash.status).toBe(201);
      expect(await refund(cash.body.id, adaToken)).toEqual({
        status: 409,
        body: { type: 'NotRefundable', message: expect.any(String) },
      });
      expect(refundRequests()).toEqual([]);
      expect(await balancesOf()).toEqual({ [adaId]: 1500, [graceId]: -1000, [linusId]: -500 });
    });

    it('refuses a settlement still pending at the provider, with 409', async () => {
      const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect((await refund(answer.body.id, adaToken)).status).toBe(409);
      expect(refundRequests()).toEqual([]);
      expect(await settlementOf(answer.body.id)).toMatchObject({ status: 'pending' });
    });

    it('refuses a settlement whose payment failed, with 409', async () => {
      const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect((await decide('pay_1', 'failed')).status).toBe(204);
      expect((await refund(answer.body.id, adaToken)).status).toBe(409);
      expect(refundRequests()).toEqual([]);
      expect(await settlementOf(answer.body.id)).toMatchObject({ status: 'failed' });
    });

    it('refuses a second refund of a settlement already refunding, with 409, and asks the provider once', async () => {
      const settlement = await paidSettlement();
      expect((await refund(settlement, adaToken)).status).toBe(204);
      expect(await refund(settlement, adaToken)).toEqual({
        status: 409,
        body: { type: 'NotRefundable', message: expect.any(String) },
      });
      expect(refundRequests()).toHaveLength(1);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'refunding' });
    });

    it('refuses a refund of a settlement the provider already refunded, with 409', async () => {
      const settlement = await paidSettlement();
      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      expect((await refund(settlement, adaToken)).status).toBe(409);
      expect(refundRequests()).toEqual([]);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'refunded' });
    });

    it('refuses a refund when its payer has left the group, and the balances still add up to 0', async () => {
      const settlement = await paidSettlement();
      // Grace is at balance 0 once the payment is paid, so Grace may leave the group.
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken })).status).toBe(204);
      expect(await refund(settlement, adaToken)).toEqual({
        status: 409,
        body: { type: 'NotRefundable', message: expect.any(String) },
      });
      expect(refundRequests()).toEqual([]);
      // Grace has left the group, so only Ada reads the settlement now.
      expect((await call(app, 'GET', `/settlements/${settlement}`, { token: adaToken })).body).toMatchObject({
        status: 'paid',
      });
      const balances = await balancesOf();
      expect(balances).toEqual({ [adaId]: 1000, [linusId]: -1000 });
      expect(Object.values(balances).reduce((sum, value) => sum + value, 0)).toBe(0);
    });
  });

  describe('when the provider does not take the refund', () => {
    it.each([200, 202, 404, 500])(
      'refuses a refund the provider answers with %i, with 424, and changes nothing',
      async status => {
        const settlement = await paidSettlement();
        provider.answer = () => ({ status, body: { id: 'ref_1' } });
        expect(await refund(settlement, adaToken)).toEqual({
          status: 424,
          body: { type: 'ProviderUnavailable', message: expect.any(String) },
        });
        expect(await settlementOf(settlement)).toMatchObject({ status: 'paid' });
        expect(await balancesOf()).toEqual(paidBalances());
      },
    );

    it('refuses a refund the provider answers with 201 and no refund id, with 424', async () => {
      const settlement = await paidSettlement();
      provider.answer = () => ({ status: 201, body: {} });
      expect((await refund(settlement, adaToken)).status).toBe(424);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'paid' });
    });

    it('refuses a refund the provider answers with 201 and text that is not JSON, with 424', async () => {
      const settlement = await paidSettlement();
      provider.answer = () => ({ status: 201, raw: 'refunded, we think' });
      expect((await refund(settlement, adaToken)).status).toBe(424);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'paid' });
    });

    it('refuses a refund the provider does not answer in time, with 424, and changes nothing', async () => {
      const settlement = await paidSettlement();
      const impatient = await startApplication(database.path, {
        providerUrl: provider.url,
        providerWebhookSecret: SECRET,
        providerTimeoutMs: 100,
      });
      extraApps.push(impatient);
      provider.answer = () => ({ status: 201, body: { id: 'ref_late' }, delayMs: 500 });
      expect((await refund(settlement, adaToken, impatient)).status).toBe(424);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'paid' });
      expect(await balancesOf()).toEqual(paidBalances());
    });

    it('asks the provider again, and refunds, once it has refused a refund', async () => {
      const settlement = await paidSettlement();
      provider.answer = () => ({ status: 500, body: {} });
      expect((await refund(settlement, adaToken)).status).toBe(424);
      provider.answer = () => ({ status: 201, body: { id: 'ref_2' } });
      expect((await refund(settlement, adaToken)).status).toBe(204);
      expect(refundRequests()).toHaveLength(2);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'refunding' });
    });

    it('refuses a refund on a server with no payment provider set up, with 409, and changes nothing', async () => {
      const settlement = await paidSettlement();
      const unconfigured = await startApplication(database.path);
      extraApps.push(unconfigured);
      expect(await refund(settlement, adaToken, unconfigured)).toEqual({
        status: 409,
        body: { type: 'ProviderNotConfigured', message: expect.any(String) },
      });
      expect(refundRequests()).toEqual([]);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'paid' });
    });
  });

  describe('the refunds that are still waiting', () => {
    it('keeps a member in the group while a refund for them is still waiting, even at balance 0', async () => {
      const settlement = await paidSettlement();
      expect((await refund(settlement, adaToken)).status).toBe(204);
      // Grace is at balance 0 and has nothing else waiting, but the refund still moves Grace's balance.
      const leaving = await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken });
      expect(leaving.status).toBe(409);
      expect(leaving.body.type).toBe('SettlementWaiting');
    });
  });

  describe('webhooks that say refunded', () => {
    it('keeps the balances at a total of 0 when the provider refunds a payment whose payer has left', async () => {
      const settlement = await paidSettlement();
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken })).status).toBe(204);
      expect(await balancesOf()).toEqual({ [adaId]: 1000, [linusId]: -1000 });

      // The provider refunds the payment on its own: Grace owes 1000 again, and Ada, who took over Grace's balance, carries it.
      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      // Grace has left, so the settlement is read by Ada, a member.
      expect((await call(app, 'GET', `/settlements/${settlement}`, { token: adaToken })).body).toMatchObject({
        status: 'refunded',
      });
      const after = await balancesOf();
      expect(Object.values(after).reduce((sum, value) => sum + value, 0)).toBe(0);
      expect(after).toEqual({ [adaId]: 1000, [linusId]: -1000 });
    });

    it('refunds a payment the provider refunds on its own, with no refund asked, and the balances go back', async () => {
      const settlement = await paidSettlement();
      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'refunded' });
      expect(await balancesOf()).toEqual(unpaidBalances());
    });

    it('counts a refund once when it is said twice, under two ids', async () => {
      const settlement = await paidSettlement();
      expect((await decide('pay_1', 'refunded', 'wh_first')).status).toBe(204);
      expect((await decide('pay_1', 'refunded', 'wh_second')).status).toBe(204);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'refunded' });
      expect(await balancesOf()).toEqual(unpaidBalances());
    });

    it('changes nothing when a success or a pending for the payment comes after its refund', async () => {
      const settlement = await paidSettlement();
      await decide('pay_1', 'refunded');
      expect((await decide('pay_1', 'succeeded', 'wh_late_success')).status).toBe(204);
      expect((await decide('pay_1', 'pending', 'wh_late_pending')).status).toBe(204);
      expect(await settlementOf(settlement)).toMatchObject({ status: 'refunded' });
      expect(await balancesOf()).toEqual(unpaidBalances());
    });

    it('ends refunded a payment refunded before its success, so the settlement is never counted', async () => {
      const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      expect(await settlementOf(answer.body.id)).toMatchObject({ status: 'refunded' });
      expect((await decide('pay_1', 'succeeded', 'wh_late_success')).status).toBe(204);
      expect(await settlementOf(answer.body.id)).toMatchObject({ status: 'refunded' });
      expect(await balancesOf()).toEqual(unpaidBalances());
    });

    it('ends refunded a refund that overtakes the provider’s answer to the payment, once the answer is kept', async () => {
      const overtaking = new Promise<Answer>(resolve => {
        provider.answer = () => {
          resolve(decide('pay_1', 'refunded'));
          return { status: 201, body: { id: 'pay_1', payUrl: 'https://pay.example/pay_1' }, delayMs: 200 };
        };
      });
      const asking = askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect((await overtaking).status).toBe(204);
      const answer = await asking;
      expect(answer.status).toBe(201);
      expect(await settlementOf(answer.body.id)).toMatchObject({ status: 'refunded' });
      expect(await balancesOf()).toEqual(unpaidBalances());
    });

    it('changes nothing when a refund comes after the payment failed', async () => {
      const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      await decide('pay_1', 'failed');
      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      expect(await settlementOf(answer.body.id)).toMatchObject({ status: 'failed' });
      expect(await balancesOf()).toEqual(unpaidBalances());
    });
  });
});
