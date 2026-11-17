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

const PAST_DAY = '2026-11-01';
// The provider's id of Ada's payout account.
const adaPayout = 'acct_ada';
const SECRET = 'whsec_test';
const AT = '2026-11-20T10:00:00Z';

describe('paying through the payment provider: the provider’s webhook', () => {
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

  /** Records an expense of the group by the account that signs with `token`, split as `splitExactly` says. */
  async function record(token: string, fields: Record<string, unknown>): Promise<void> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Expense', date: PAST_DAY, ...fields },
      token,
    });
    expect(answer.status).toBe(201);
  }

  const askProvider = (body: unknown, token: string) =>
    call(app, 'POST', `/groups/${groupId}/settlements/provider`, { body, token });

  const balancesOf = async (): Promise<Record<string, number>> =>
    Object.fromEntries(
      (await call(app, 'GET', `/groups/${groupId}/balances`, { token: adaToken })).body.map(
        (row: { memberId: string; balance: number }) => [row.memberId, row.balance],
      ),
    );

  /** The webhook body, as the provider sends it, and its signature with `secret`. */
  function signed(event: Record<string, unknown>, secret = SECRET): { raw: string; signature: string } {
    const raw = JSON.stringify(event);
    return { raw, signature: createHmac('sha256', secret).update(raw).digest('hex') };
  }

  /** Sends the webhook with its signature header, unless the test gives it none. */
  const send = (raw: string, signature: string | undefined, using: Application = app) =>
    call(using, 'POST', '/provider/webhooks', {
      raw,
      headers: signature === undefined ? {} : { 'Provider-Signature': signature },
    });

  const decide = (paymentId: string, status: string, id = `wh_${paymentId}_${status}`, secret = SECRET) => {
    const { raw, signature } = signed({ id, paymentId, status, at: AT }, secret);
    return send(raw, signature);
  };

  const settlementOf = async (settlementId: string) =>
    (await call(app, 'GET', `/settlements/${settlementId}`, { token: graceToken })).body;

  /** Grace asks to pay Ada 1000 through the provider; the provider's payment is `pay_1`. Returns the settlement. */
  async function askGraceToPayAda(): Promise<string> {
    const answer = await askProvider({ to: adaId, amount: 1000 }, graceToken);
    expect(answer.status).toBe(201);
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
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
    // Ada paid 3000, split equally between the three: Ada is owed 2000, Grace and Linus each owe 1000.
    await record(adaToken, {
      amount: 3000,
      splitExactly: [
        { memberId: adaId, amount: 1000 },
        { memberId: graceId, amount: 1000 },
        { memberId: linusId, amount: 1000 },
      ],
    });
  });

  afterEach(async () => {
    for (const extra of extraApps.splice(0)) await extra.stop();
    await app.stop();
    await provider.stop();
    database.remove();
  });

  describe('the signature', () => {
    it('refuses a webhook without a signature, and changes nothing', async () => {
      const settlement = await askGraceToPayAda();
      const { raw } = signed({ id: 'wh_1', paymentId: 'pay_1', status: 'succeeded', at: AT });
      const answer = await send(raw, undefined);
      expect(answer.status).toBe(401);
      expect((await settlementOf(settlement)).status).toBe('pending');
      expect(await balancesOf()).toEqual({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });
    });

    it('refuses a webhook whose signature is wrong, and changes nothing', async () => {
      const settlement = await askGraceToPayAda();
      const { raw, signature } = signed(
        { id: 'wh_1', paymentId: 'pay_1', status: 'succeeded', at: AT },
        'another-secret',
      );
      expect((await send(raw, signature)).status).toBe(401);
      expect((await settlementOf(settlement)).status).toBe('pending');
    });

    it('refuses a webhook whose body was changed after it was signed', async () => {
      const settlement = await askGraceToPayAda();
      const signedBody = signed({ id: 'wh_1', paymentId: 'pay_1', status: 'failed', at: AT });
      const tampered = JSON.stringify({ id: 'wh_1', paymentId: 'pay_1', status: 'succeeded', at: AT });
      expect((await send(tampered, signedBody.signature)).status).toBe(401);
      expect((await settlementOf(settlement)).status).toBe('pending');
    });

    it('refuses a signature in uppercase hexadecimal, which is not the one the provider sends', async () => {
      await askGraceToPayAda();
      const { raw, signature } = signed({ id: 'wh_1', paymentId: 'pay_1', status: 'succeeded', at: AT });
      expect((await send(raw, signature.toUpperCase())).status).toBe(401);
    });

    it('refuses every webhook on a server with no webhook secret set', async () => {
      const unsecured = await startApplication(database.path, { providerUrl: provider.url, providerWebhookSecret: '' });
      extraApps.push(unsecured);
      const { raw, signature } = signed({ id: 'wh_1', paymentId: 'pay_1', status: 'succeeded', at: AT }, '');
      expect((await send(raw, signature, unsecured)).status).toBe(401);
    });

    it('answers 401 for a webhook that is not JSON and carries no signature', async () => {
      expect((await send('not json', undefined)).status).toBe(401);
    });
  });

  describe('a payment that succeeds', () => {
    it('makes the settlement paid, and the balances count it as a cash settlement does', async () => {
      const settlement = await askGraceToPayAda();
      const answer = await decide('pay_1', 'succeeded');
      expect(answer.status).toBe(204);
      expect(await settlementOf(settlement)).toMatchObject({ method: 'provider', status: 'paid', amount: 1000 });
      expect(await balancesOf()).toEqual({ [adaId]: 1000, [graceId]: 0, [linusId]: -1000 });
    });

    it('counts it in the suggested settlements from then on', async () => {
      await askGraceToPayAda();
      await decide('pay_1', 'succeeded');
      const suggested = await call(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: adaToken });
      expect(suggested.body).toEqual([{ from: linusId, to: adaId, amount: 1000 }]);
    });

    it('acknowledges the same success again, and changes nothing more', async () => {
      const settlement = await askGraceToPayAda();
      await decide('pay_1', 'succeeded', 'wh_same');
      expect((await decide('pay_1', 'succeeded', 'wh_same')).status).toBe(204);
      expect((await settlementOf(settlement)).status).toBe('paid');
      expect(await balancesOf()).toEqual({ [adaId]: 1000, [graceId]: 0, [linusId]: -1000 });
    });

    it('does not undo it when a failure for the same payment comes after it', async () => {
      const settlement = await askGraceToPayAda();
      await decide('pay_1', 'succeeded');
      expect((await decide('pay_1', 'failed')).status).toBe(204);
      expect((await settlementOf(settlement)).status).toBe('paid');
      expect(await balancesOf()).toEqual({ [adaId]: 1000, [graceId]: 0, [linusId]: -1000 });
    });
  });

  describe('a payment that fails', () => {
    it('makes the settlement failed, and the balances never count it', async () => {
      const settlement = await askGraceToPayAda();
      expect((await decide('pay_1', 'failed')).status).toBe(204);
      expect(await settlementOf(settlement)).toMatchObject({ method: 'provider', status: 'failed' });
      expect(await balancesOf()).toEqual({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });
    });

    it('frees what the payment held, so the payer may ask for it again', async () => {
      await askGraceToPayAda();
      // Grace owes 1000 and that 1000 is held by the waiting payment: a second one is refused.
      expect((await askProvider({ to: adaId, amount: 1000 }, graceToken)).status).toBe(409);
      await decide('pay_1', 'failed');
      expect((await askProvider({ to: adaId, amount: 1000 }, graceToken)).status).toBe(201);
    });

    it('does not count it in the suggested settlements', async () => {
      await askGraceToPayAda();
      await decide('pay_1', 'failed');
      const suggested = await call(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: adaToken });
      // Back to the balances before the payment: Grace and Linus each still owe Ada 1000.
      expect(suggested.body).toEqual([
        { from: graceId, to: adaId, amount: 1000 },
        { from: linusId, to: adaId, amount: 1000 },
      ]);
    });

    it('does not let a failure after a success take the settlement back to failed', async () => {
      const settlement = await askGraceToPayAda();
      await decide('pay_1', 'failed');
      await decide('pay_1', 'succeeded');
      expect((await settlementOf(settlement)).status).toBe('failed');
      expect(await balancesOf()).toEqual({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });
    });
  });

  describe('what changes nothing', () => {
    it('changes nothing for a payment still pending at the provider', async () => {
      const settlement = await askGraceToPayAda();
      expect((await decide('pay_1', 'pending')).status).toBe(204);
      expect((await settlementOf(settlement)).status).toBe('pending');
      expect(await balancesOf()).toEqual({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });
    });

    it('acknowledges a webhook about a payment Tally does not know, and changes nothing', async () => {
      const settlement = await askGraceToPayAda();
      expect((await decide('pay_unknown', 'succeeded')).status).toBe(204);
      expect((await settlementOf(settlement)).status).toBe('pending');
      expect(await balancesOf()).toEqual({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });
    });

    it('acknowledges a signed webhook whose status it does not know, and changes nothing', async () => {
      const settlement = await askGraceToPayAda();
      expect((await decide('pay_1', 'authorized')).status).toBe(204);
      expect((await settlementOf(settlement)).status).toBe('pending');
    });

    it('acknowledges a signed webhook whose body is not what a webhook is, and changes nothing', async () => {
      const settlement = await askGraceToPayAda();
      const raw = 'this is not json';
      const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
      expect((await send(raw, signature)).status).toBe(204);
      expect((await settlementOf(settlement)).status).toBe('pending');
    });

    it('answers the other routes as before once webhooks have come', async () => {
      await askGraceToPayAda();
      await decide('pay_1', 'succeeded');
      expect((await call(app, 'POST', '/accounts/login', { body: ada })).status).toBe(200);
      expect((await call(app, 'GET', `/groups/${groupId}/balances`, { token: adaToken })).status).toBe(200);
    });
  });

  describe('webhooks that come twice, late, out of order, or at the same moment', () => {
    const paidBalances = (): Record<string, number> => ({ [adaId]: 1000, [graceId]: 0, [linusId]: -1000 });
    const unpaidBalances = (): Record<string, number> => ({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });

    it('keeps a payment paid when a pending for it comes after its success', async () => {
      const settlement = await askGraceToPayAda();
      await decide('pay_1', 'succeeded');
      expect((await decide('pay_1', 'pending')).status).toBe(204);
      expect((await settlementOf(settlement)).status).toBe('paid');
      expect(await balancesOf()).toEqual(paidBalances());
    });

    it('keeps a payment failed when a pending for it comes after its failure', async () => {
      const settlement = await askGraceToPayAda();
      await decide('pay_1', 'failed');
      expect((await decide('pay_1', 'pending')).status).toBe(204);
      expect((await settlementOf(settlement)).status).toBe('failed');
      expect(await balancesOf()).toEqual(unpaidBalances());
    });

    it('counts a payment once when two webhooks, under two ids, say it succeeded', async () => {
      const settlement = await askGraceToPayAda();
      expect((await decide('pay_1', 'succeeded', 'wh_first')).status).toBe(204);
      expect((await decide('pay_1', 'succeeded', 'wh_second')).status).toBe(204);
      expect((await settlementOf(settlement)).status).toBe('paid');
      expect(await balancesOf()).toEqual(paidBalances());
      const suggested = await call(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: adaToken });
      expect(suggested.body).toEqual([{ from: linusId, to: adaId, amount: 1000 }]);
    });

    it.each(['succeeded', 'failed'])(
      'applies a %s that overtakes the provider’s answer to the payment, once the answer is kept',
      async status => {
        // The provider sends its webhook before it answers, and the answer comes late: the settlement has no
        // payment id yet when the webhook arrives.
        const overtaking = new Promise<Answer>(resolve => {
          provider.answer = () => {
            resolve(decide('pay_1', status));
            return { status: 201, body: { id: 'pay_1', payUrl: 'https://pay.example/pay_1' }, delayMs: 200 };
          };
        });
        const asking = askProvider({ to: adaId, amount: 1000 }, graceToken);
        expect((await overtaking).status).toBe(204);
        const answer = await asking;
        expect(answer.status).toBe(201);
        const settlement = await settlementOf(answer.body.id);
        expect(settlement.status).toBe(status === 'succeeded' ? 'paid' : 'failed');
        expect(await balancesOf()).toEqual(status === 'succeeded' ? paidBalances() : unpaidBalances());
      },
    );

    it('changes a payment as it would have on time, when the webhook comes after Tally was stopped and started', async () => {
      const settlement = await askGraceToPayAda();
      await app.stop();
      app = await startApplication(database.path, { providerUrl: provider.url, providerWebhookSecret: SECRET });
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      expect((await settlementOf(settlement)).status).toBe('paid');
      expect(await balancesOf()).toEqual(paidBalances());
      // Sent again after another restart, the same success changes nothing.
      await app.stop();
      app = await startApplication(database.path, { providerUrl: provider.url, providerWebhookSecret: SECRET });
      expect((await decide('pay_1', 'succeeded', 'wh_again')).status).toBe(204);
      expect(await balancesOf()).toEqual(paidBalances());
    });

    it('counts a payment once when the same webhook reaches two servers on the same database at once', async () => {
      const second = await startApplication(database.path, {
        providerUrl: provider.url,
        providerWebhookSecret: SECRET,
      });
      extraApps.push(second);
      const settlement = await askGraceToPayAda();
      const { raw, signature } = signed({ id: 'wh_same', paymentId: 'pay_1', status: 'succeeded', at: AT });
      const answers = await Promise.all([0, 1, 2, 3].map(n => send(raw, signature, n % 2 === 0 ? app : second)));
      expect(answers.map(answer => answer.status)).toEqual([204, 204, 204, 204]);
      expect((await settlementOf(settlement)).status).toBe('paid');
      expect(await balancesOf()).toEqual(paidBalances());
    });

    it('lets one decision end a payment when a success and a failure reach two servers at once', async () => {
      const second = await startApplication(database.path, {
        providerUrl: provider.url,
        providerWebhookSecret: SECRET,
      });
      extraApps.push(second);
      const settlement = await askGraceToPayAda();
      const failure = signed({ id: 'wh_failed', paymentId: 'pay_1', status: 'failed', at: AT });
      const answers = await Promise.all([
        decide('pay_1', 'succeeded', 'wh_succeeded'),
        send(failure.raw, failure.signature, second),
      ]);
      expect(answers.map(answer => answer.status)).toEqual([204, 204]);
      const status = (await settlementOf(settlement)).status;
      expect(['paid', 'failed']).toContain(status);
      expect(await balancesOf()).toEqual(status === 'paid' ? paidBalances() : unpaidBalances());
      // The other decision, sent after, changes nothing.
      await decide('pay_1', status === 'paid' ? 'failed' : 'succeeded', 'wh_contrary');
      expect((await settlementOf(settlement)).status).toBe(status);
      expect(await balancesOf()).toEqual(status === 'paid' ? paidBalances() : unpaidBalances());
    });
  });

  describe('the settlements that are still waiting', () => {
    it('keeps a member in the group while a payment for them is still waiting, even at balance 0', async () => {
      // Grace owes 1000 and asks to pay it; then Grace paid 1000 for Ada alone, which brings Grace's balance to 0
      // while the payment still waits: once it succeeds, Grace would be owed 1000 after leaving.
      await askGraceToPayAda();
      await record(graceToken, {
        amount: 1000,
        splitExactly: [
          { memberId: graceId, amount: 0 },
          { memberId: adaId, amount: 1000 },
        ],
      });
      expect(await balancesOf()).toEqual({ [adaId]: 1000, [graceId]: 0, [linusId]: -1000 });
      const leaving = await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken });
      expect(leaving.status).toBe(409);
      expect(leaving.body.type).toBe('SettlementWaiting');
      await decide('pay_1', 'failed');
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken })).status).toBe(204);
    });
  });
});
