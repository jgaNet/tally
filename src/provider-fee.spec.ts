import { createHmac } from 'node:crypto';
import pg from 'pg';
import { Application } from './app';
import {
  ada,
  call,
  FakeProvider,
  readRows,
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

describe("the provider's fee: who bears it, and what a payment through the provider settles", () => {
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

  const askProvider = (body: unknown, token = graceToken) =>
    call(app, 'POST', `/groups/${groupId}/settlements/provider`, { body, token });

  const setPolicy = (borneBy: string) =>
    call(app, 'PUT', `/groups/${groupId}/fee-policy`, { body: { borneBy }, token: adaToken });

  const balancesOf = async (): Promise<Record<string, number>> =>
    Object.fromEntries(
      (await call(app, 'GET', `/groups/${groupId}/balances`, { token: adaToken })).body.map(
        (row: { memberId: string; balance: number }) => [row.memberId, row.balance],
      ),
    );

  const settlementOf = async (id: string) => (await call(app, 'GET', `/settlements/${id}`, { token: graceToken })).body;

  /** The rows of the settlements table, read apart from the application, as the file keeps them. */
  const settlementRows = (): Promise<Array<Record<string, unknown>>> =>
    readRows(database.url, 'SELECT * FROM settlements');

  /**
   * The provider answers each payment with `fee`, a payment id of its own and a link; a `fee` of `undefined` is left out of the
   * answer. A refund is answered as the provider answers one.
   */
  function feeOf(fee: unknown): void {
    provider.answer = (request, number) =>
      request.path.endsWith('/refunds')
        ? { status: 201, body: { id: `ref_${number}` } }
        : { status: 201, body: { id: `pay_${number}`, payUrl: `https://pay.example/pay_${number}`, fee } };
  }

  /** The id of the payment the provider made last: the provider numbers its answers by the requests it receives. */
  const lastPaymentId = (): string => `pay_${provider.requests.length}`;

  /** The provider's webhook for the payment, with the status it decides, signed with the secret. */
  function decide(paymentId: string, status: string) {
    const raw = JSON.stringify({ id: `wh_${paymentId}_${status}`, paymentId, status, at: AT });
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    return call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  }

  /** Clears the fee and who bore it of a settlement, as a settlement asked for before fees were kept has them. */
  async function forgetFee(settlementId: string): Promise<void> {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query('UPDATE settlements SET fee_amount = NULL, fee_borne_by = NULL WHERE id = $1', [settlementId]);
    } finally {
      await client.end();
    }
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, { providerUrl: provider.url, providerWebhookSecret: SECRET });
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
    feeOf(0);
  });

  afterEach(async () => {
    for (const extra of extraApps.splice(0)) await extra.stop();
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  describe('what a settlement through the provider settles, once the provider says it succeeded', () => {
    // Grace pays Ada 300 through the provider, and the provider's fee is 31: whoever bears it, what the settlement settles is
    // 300 when the payee bears it, 269 when the payer does, and 285 when they share it (the payer's half, 15, rounded down).
    it.each([
      ['payee', 31, 300],
      ['payer', 31, 269],
      ['shared', 31, 285],
      ['shared', 30, 285],
      ['payer', 0, 300],
    ] as const)(
      'when the %s bears a fee of %i, settles %i: the balances, the statement and the read settlement say so',
      async (borneBy, fee, settled) => {
        expect((await setPolicy(borneBy)).status).toBe(204);
        feeOf(fee);
        const { id } = (await askProvider({ to: adaId, amount: 300 })).body;
        expect((await decide(lastPaymentId(), 'succeeded')).status).toBe(204);

        expect(await balancesOf()).toEqual({ [adaId]: 2000 - settled, [graceId]: -1000 + settled, [linusId]: -1000 });
        expect(await settlementOf(id)).toMatchObject({ amount: 300, status: 'paid', fee: { amount: fee, borneBy } });
        const statement = (
          await call(app, 'GET', `/groups/${groupId}/members/${graceId}/statement`, { token: graceToken })
        ).body;
        expect(statement.entries).toContainEqual(
          expect.objectContaining({ kind: 'settlement', settlementId: id, paid: settled, share: 0 }),
        );
        expect(statement.balance).toBe(-1000 + settled);
      },
    );

    it('counts what is still owed while the payment waits, less the part of the fee its payer bears', async () => {
      expect((await setPolicy('payer')).status).toBe(204);
      feeOf(31);
      const { id } = (await askProvider({ to: adaId, amount: 300 })).body;
      expect(await settlementOf(id)).toMatchObject({ status: 'pending', fee: { amount: 31, borneBy: 'payer' } });
      // Not yet paid: the balances are as they were, but the suggested transfers are made on what is still owed.
      expect(await balancesOf()).toEqual({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });
      const suggested = await call(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: adaToken });
      expect(suggested.body).toEqual([
        { from: linusId, to: adaId, amount: 1000 },
        { from: graceId, to: adaId, amount: 731 },
      ]);
    });

    it('keeps the fee and who bore it when the payment was asked for: a later change of the policy changes no settlement', async () => {
      feeOf(31);
      const { id } = (await askProvider({ to: adaId, amount: 300 })).body;
      expect((await setPolicy('payer')).status).toBe(204);
      expect((await decide(lastPaymentId(), 'succeeded')).status).toBe(204);
      expect(await settlementOf(id)).toMatchObject({ fee: { amount: 31, borneBy: 'payee' } });
      expect(await balancesOf()).toEqual({ [adaId]: 1700, [graceId]: -700, [linusId]: -1000 });
    });

    it('applies the policy in force when the payment is asked for', async () => {
      expect((await setPolicy('shared')).status).toBe(204);
      feeOf(31);
      const { id } = (await askProvider({ to: adaId, amount: 300 })).body;
      expect((await setPolicy('payee')).status).toBe(204);
      expect(await settlementOf(id)).toMatchObject({ fee: { amount: 31, borneBy: 'shared' } });
    });

    it('settles its amount, and has no fee, when it was asked for before fees were kept', async () => {
      expect((await setPolicy('payer')).status).toBe(204);
      feeOf(31);
      const { id } = (await askProvider({ to: adaId, amount: 300 })).body;
      await forgetFee(id);
      expect((await decide(lastPaymentId(), 'succeeded')).status).toBe(204);
      const read = await settlementOf(id);
      expect(read).not.toHaveProperty('fee');
      expect(read).toMatchObject({ amount: 300, status: 'paid' });
      expect(await balancesOf()).toEqual({ [adaId]: 1700, [graceId]: -700, [linusId]: -1000 });
    });

    it('audits the settlement as what it settles: paid, then refunded, the amount it settled, and contested too', async () => {
      expect((await setPolicy('payer')).status).toBe(204);
      feeOf(31);
      const { id } = (await askProvider({ to: adaId, amount: 300 })).body;
      const paymentId = lastPaymentId();
      expect((await decide(paymentId, 'succeeded')).status).toBe(204);
      expect((await call(app, 'POST', `/settlements/${id}/refund`, { token: adaToken })).status).toBe(204);
      expect((await decide(paymentId, 'refunded')).status).toBe(204);

      const audit = (await call(app, 'GET', `/groups/${groupId}/audit`, { token: adaToken })).body;
      expect(audit.filter((entry: { subjectId: string }) => entry.subjectId === id)).toEqual([
        expect.objectContaining({ action: 'settlement-paid', by: graceId, amount: 269 }),
        expect.objectContaining({ action: 'settlement-refunded', by: adaId, amount: 269 }),
      ]);
    });

    it('audits a contest of a settlement at what it settles', async () => {
      expect((await setPolicy('shared')).status).toBe(204);
      feeOf(31);
      const { id } = (await askProvider({ to: adaId, amount: 300 })).body;
      expect((await decide(lastPaymentId(), 'succeeded')).status).toBe(204);
      expect((await call(app, 'POST', `/settlements/${id}/contest`, { token: adaToken })).status).toBe(204);
      const audit = (await call(app, 'GET', `/groups/${groupId}/audit`, { token: adaToken })).body;
      expect(audit).toContainEqual(
        expect.objectContaining({ action: 'settlement-contested', subjectId: id, by: adaId, amount: 285 }),
      );
    });
  });

  describe('a provider answer without a fee, or with one that is not less than the amount', () => {
    it.each([
      ['no fee', undefined],
      ['a fee that is not a whole number', 1.5],
      ['a fee that is negative', -1],
      ['a fee that is a text', '31'],
      ['a fee that is null', null],
      ['a fee equal to the amount', 300],
      ['a fee more than the amount', 301],
    ])('refuses the payment, and keeps nothing, when the answer has %s', async (_label, fee) => {
      feeOf(fee);
      const answer = await askProvider({ to: adaId, amount: 300 });
      expect(answer.status).toBe(424);
      expect(answer.body.type).toBe('ProviderUnavailable');
      expect(await settlementRows()).toHaveLength(0);
      expect(await balancesOf()).toEqual({ [adaId]: 2000, [graceId]: -1000, [linusId]: -1000 });
    });

    it('asks again once the provider answers with a fee, and then keeps the settlement', async () => {
      feeOf(undefined);
      expect((await askProvider({ to: adaId, amount: 300 })).status).toBe(424);
      feeOf(31);
      const answer = await askProvider({ to: adaId, amount: 300 });
      expect(answer.status).toBe(201);
      expect(await settlementOf(answer.body.id)).toMatchObject({
        status: 'pending',
        fee: { amount: 31, borneBy: 'payee' },
      });
    });
  });
});
