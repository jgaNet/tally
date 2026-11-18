import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Application, createApplication } from './app';
import { type Database, openDatabase } from './database';
import { recordStatus } from './settlements';
import { ensureDatabase, send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

const SECRET = 'shared with the provider';

/** The provider's id of Ann's payout account, which the fixture sets; the fake provider knows every account. */
const ANN_PAYOUT = 'acct_ann';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The webhook signature the provider puts on a body: HMAC-SHA256, in lowercase hexadecimal. */
function signed(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

/** A member's balance by member id, as the group's balances read them. */
type Balances = Record<string, number>;

describe('the provider fee', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: Database;
  let provider: Server;
  let providerUrl: string;
  /** The fee the fake provider keeps in each payment it creates, as it answers it: `undefined` leaves it out. */
  let fee: unknown;
  /** How many payments the fake provider has been asked for, so each has an id `pay_<n>`. */
  let payments: number;

  beforeEach(async () => {
    directory = testDirectory();
    fee = 0;
    payments = 0;
    provider = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => (raw += chunk));
      request.on('end', () => {
        const json = { 'content-type': 'application/json' };
        if (request.url?.startsWith('/accounts/')) {
          response.writeHead(200, json);
          response.end(JSON.stringify({ id: decodeURIComponent(request.url.slice('/accounts/'.length)) }));
          return;
        }
        if (request.url?.endsWith('/refunds')) {
          response.writeHead(201, json);
          response.end(JSON.stringify({ id: 're_1' }));
          return;
        }
        const n = ++payments;
        response.writeHead(201, json);
        response.end(JSON.stringify({ id: `pay_${n}`, payUrl: `https://pay.example.org/${n}`, fee }));
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    await ensureDatabase(directory.databaseUrl);
    app = await createApplication({
      databaseUrl: directory.databaseUrl,
      providerUrl,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 200,
    });
    await app.start(0);
    db = await openDatabase({ url: directory.databaseUrl });
  });

  afterEach(async () => {
    await db.close();
    await app.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    provider.closeAllConnections();
    await directory.remove();
  });

  /**
   * Ann and Ben in a group Ann owns: Ann paid 3000 split equally, so Ben owes Ann 1500. Ann has a payout account at the
   * provider. Answers the ids and tokens.
   */
  async function annAndBen(): Promise<{
    ann: string;
    annToken: string;
    ben: string;
    benToken: string;
    groupId: string;
  }> {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const created = await send(app, 'POST', '/groups', { token: ann.token, body: { name: 'Trip', currency: 'EUR' } });
    const groupId = (created.body as { id: string }).id;
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ann.token });
    const accepted = await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: ben.token,
    });
    if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 3000, date: utcDay(0), splitBetween: [ann.id, ben.id] },
    });
    if (expense.status !== 201) throw new Error(`record answered ${expense.status}`);
    const payout = await send(app, 'PUT', '/accounts/me/payout-account', {
      token: ann.token,
      body: { accountId: ANN_PAYOUT },
    });
    if (payout.status !== 204) throw new Error(`payout account answered ${payout.status}`);
    return { ann: ann.id, annToken: ann.token, ben: ben.id, benToken: ben.token, groupId };
  }

  /** Sets who bears the fee of the group, as its owner `token`. */
  async function decideFee(token: string, groupId: string, borneBy: string): Promise<void> {
    const reply = await send(app, 'PUT', `/groups/${groupId}/fee-policy`, { token, body: { borneBy } });
    if (reply.status !== 204) throw new Error(`fee policy answered ${reply.status}`);
  }

  /** Asks the provider for a payment of `amount` from Ben to Ann. */
  function askBenToPayAnn(benToken: string, groupId: string, annId: string, amount: number) {
    return send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: benToken,
      body: { to: annId, amount },
    });
  }

  /** The provider's signed webhook saying the payment `paymentId` has `status`. */
  async function providerSays(paymentId: string, status: string): Promise<number> {
    const body = JSON.stringify({ id: `evt_${paymentId}_${status}`, paymentId, status, at: new Date().toISOString() });
    const response = await fetch(`${app.address}/${app.apiPrefix}/provider/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'provider-signature': signed(body) },
      body,
    });
    return response.status;
  }

  async function balancesAs(token: string, groupId: string): Promise<Balances> {
    const reply = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    const rows = reply.body as { memberId: string; balance: number }[];
    return Object.fromEntries(rows.map(row => [row.memberId, row.balance]));
  }

  async function suggestionsAs(token: string, groupId: string) {
    const reply = await send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token });
    return reply.body as { from: string; to: string; amount: number }[];
  }

  async function statementOf(token: string, groupId: string, memberId: string) {
    const reply = await send(app, 'GET', `/groups/${groupId}/members/${memberId}/statement`, { token });
    return reply.body as {
      balance: number;
      entries: { kind: string; settlementId?: string; paid: number; share: number; balance: number }[];
    };
  }

  async function auditOf(token: string, groupId: string) {
    const reply = await send(app, 'GET', `/groups/${groupId}/audit`, { token });
    return reply.body as { action: string; subjectId: string; by: string; amount: number }[];
  }

  async function settlementCount(): Promise<number> {
    return ((await db.prepare('SELECT COUNT(*) AS n FROM settlements').get()) as { n: number }).n;
  }

  it('refuses a payment whose provider answer has no fee, or one that is not a fee of the payment, and keeps nothing', async () => {
    const { ann, ben, benToken, groupId } = await annAndBen();
    // 300 is the amount asked: a fee must be a whole number from 0, and less than 300.
    const refused: [string, unknown][] = [
      ['missing', undefined],
      ['a string', '31'],
      ['a fraction', 31.5],
      ['negative', -1],
      ['as much as the amount', 300],
      ['more than the amount', 301],
      ['null', null],
    ];
    for (const [name, value] of refused) {
      fee = value;
      const reply = await askBenToPayAnn(benToken, groupId, ann, 300);
      expect({ name, status: reply.status }).toEqual({ name, status: 424 });
      expect(reply.body).toMatchObject({ error: 'ProviderUnavailable' });
      expect(await settlementCount()).toBe(0);
    }
    expect(await balancesAs(benToken, groupId)).toEqual({ [ann]: 1500, [ben]: -1500 });
  });

  it('accepts a fee of 0, and a fee one hundredth less than the amount', async () => {
    const { ann, benToken, groupId } = await annAndBen();
    fee = 0;
    expect((await askBenToPayAnn(benToken, groupId, ann, 300)).status).toBe(201);
    fee = 299;
    expect((await askBenToPayAnn(benToken, groupId, ann, 300)).status).toBe(201);
    expect(await settlementCount()).toBe(2);
  });

  it('with no decision, the payee bears the fee: the settlement settles its whole amount, and keeps the fee it was asked with', async () => {
    const { ann, ben, benToken, groupId } = await annAndBen();
    fee = 31;
    const asked = await askBenToPayAnn(benToken, groupId, ann, 300);
    expect(asked.status).toBe(201);
    const id = (asked.body as { id: string }).id;

    const read = await send(app, 'GET', `/settlements/${id}`, { token: benToken });
    expect(read.body).toMatchObject({
      id,
      amount: 300,
      method: 'provider',
      status: 'pending',
      fee: { amount: 31, borneBy: 'payee' },
    });
    // What is still owed while it waits counts it whole.
    expect(await suggestionsAs(benToken, groupId)).toEqual([{ from: ben, to: ann, amount: 1200 }]);

    expect(await providerSays('pay_1', 'succeeded')).toBe(204);
    expect(await balancesAs(benToken, groupId)).toEqual({ [ann]: 1200, [ben]: -1200 });
    expect((await send(app, 'GET', `/groups/${groupId}/settlements`, { token: benToken })).body).toEqual([
      expect.objectContaining({ id, fee: { amount: 31, borneBy: 'payee' } }),
    ]);
  });

  it('when the payer bears the fee, the settlement settles its amount less the fee, and the payer still owes the fee', async () => {
    const { ann, ben, benToken, annToken, groupId } = await annAndBen();
    await decideFee(annToken, groupId, 'payer');
    fee = 31;
    const id = (await askBenToPayAnn(benToken, groupId, ann, 300)).body as { id: string };

    expect(await suggestionsAs(benToken, groupId)).toEqual([{ from: ben, to: ann, amount: 1231 }]);
    expect(await providerSays('pay_1', 'succeeded')).toBe(204);

    expect(await balancesAs(annToken, groupId)).toEqual({ [ann]: 1231, [ben]: -1231 });
    const statement = await statementOf(benToken, groupId, ben);
    expect(statement.balance).toBe(-1231);
    expect(statement.entries.find(entry => entry.kind === 'settlement')).toMatchObject({
      settlementId: id.id,
      paid: 269,
      share: 0,
      balance: -1231,
    });
    expect(
      (await statementOf(annToken, groupId, ann)).entries.find(entry => entry.kind === 'settlement'),
    ).toMatchObject({
      paid: 0,
      share: 269,
    });
    // The audit records what was settled; the amount of the settlement stays the one asked for.
    expect(await auditOf(annToken, groupId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'settlement-paid', subjectId: id.id, by: ben, amount: 269 }),
      ]),
    );
    expect((await send(app, 'GET', `/settlements/${id.id}`, { token: annToken })).body).toMatchObject({
      amount: 300,
      fee: { amount: 31, borneBy: 'payer' },
    });
  });

  it('when both bear the fee, each bears half of it, and the payee bears the extra hundredth of an odd fee', async () => {
    const { ann, ben, benToken, annToken, groupId } = await annAndBen();
    await decideFee(annToken, groupId, 'shared');
    fee = 31;
    await askBenToPayAnn(benToken, groupId, ann, 300);
    // Ben bears 15 of the 31, so the settlement settles 285 and Ben owes 1215.
    expect(await suggestionsAs(benToken, groupId)).toEqual([{ from: ben, to: ann, amount: 1215 }]);
    expect(await providerSays('pay_1', 'succeeded')).toBe(204);
    expect(await balancesAs(annToken, groupId)).toEqual({ [ann]: 1215, [ben]: -1215 });
    expect(await auditOf(annToken, groupId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'settlement-paid', amount: 285 })]),
    );
  });

  it('a settlement keeps the fee and who bore it when its payment was asked for: a later decision changes no settlement', async () => {
    const { ann, ben, benToken, annToken, groupId } = await annAndBen();
    await decideFee(annToken, groupId, 'payer');
    fee = 31;
    await askBenToPayAnn(benToken, groupId, ann, 300);
    // Ann decides the payee bears it, while the payment waits.
    await decideFee(annToken, groupId, 'payee');
    expect(await suggestionsAs(benToken, groupId)).toEqual([{ from: ben, to: ann, amount: 1231 }]);
    expect(await providerSays('pay_1', 'succeeded')).toBe(204);
    expect(await balancesAs(annToken, groupId)).toEqual({ [ann]: 1231, [ben]: -1231 });
    expect((await send(app, 'GET', `/groups/${groupId}/settlements`, { token: annToken })).body).toEqual([
      expect.objectContaining({ amount: 300, fee: { amount: 31, borneBy: 'payer' } }),
    ]);

    // A payment asked for after the decision bears the fee as decided.
    fee = 31;
    await askBenToPayAnn(benToken, groupId, ann, 100);
    expect(await suggestionsAs(benToken, groupId)).toEqual([{ from: ben, to: ann, amount: 1131 }]);
  });

  it('a settlement asked for before fees has no fee, and settles its amount whatever the group decides', async () => {
    const { ann, ben, benToken, annToken, groupId } = await annAndBen();
    await decideFee(annToken, groupId, 'payer');
    // A payment asked for before this request: written as Tally kept it, with no fee.
    const id = 'legacy-settlement';
    const at = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, provider_payment_id, pay_url, created_at)
         VALUES (?, ?, ?, ?, ?, 'provider', 'pending', 'pay_legacy', 'https://pay.example.org/legacy', ?)`,
      )
      .run(id, groupId, ben, ann, 300, at);
    await recordStatus(db, id, 'pending', at);

    const read = await send(app, 'GET', `/settlements/${id}`, { token: benToken });
    expect(read.body).not.toHaveProperty('fee');
    expect(await suggestionsAs(benToken, groupId)).toEqual([{ from: ben, to: ann, amount: 1200 }]);
    expect(await providerSays('pay_legacy', 'succeeded')).toBe(204);
    expect(await balancesAs(annToken, groupId)).toEqual({ [ann]: 1200, [ben]: -1200 });
  });

  it('a refund goes back by what the settlement settled, and the audit records that amount', async () => {
    const { ann, ben, benToken, annToken, groupId } = await annAndBen();
    await decideFee(annToken, groupId, 'payer');
    fee = 31;
    const id = (await askBenToPayAnn(benToken, groupId, ann, 300)).body as { id: string };
    expect(await providerSays('pay_1', 'succeeded')).toBe(204);

    expect((await send(app, 'POST', `/settlements/${id.id}/refund`, { token: annToken })).status).toBe(204);
    expect(await providerSays('pay_1', 'refunded')).toBe(204);

    expect(await balancesAs(annToken, groupId)).toEqual({ [ann]: 1500, [ben]: -1500 });
    expect(await auditOf(annToken, groupId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'settlement-refunded', subjectId: id.id, amount: 269 }),
      ]),
    );
  });

  it('a contested settlement stops counting what it settled, and the audit records that amount', async () => {
    const { ann, ben, benToken, annToken, groupId } = await annAndBen();
    await decideFee(annToken, groupId, 'payer');
    fee = 31;
    const id = (await askBenToPayAnn(benToken, groupId, ann, 300)).body as { id: string };
    expect(await providerSays('pay_1', 'succeeded')).toBe(204);

    expect((await send(app, 'POST', `/settlements/${id.id}/contest`, { token: annToken })).status).toBe(204);

    expect(await balancesAs(annToken, groupId)).toEqual({ [ann]: 1500, [ben]: -1500 });
    expect(await auditOf(annToken, groupId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'settlement-contested', subjectId: id.id, amount: 269 }),
      ]),
    );
  });
});
