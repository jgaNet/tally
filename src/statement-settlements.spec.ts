import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { type Application, createApplication } from './app';
import { openDatabase } from './database';
import { send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

const SECRET = 'shared with the provider';
const HEADER = 'date,kind,id,description,paid,share,balance\r\n';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The signature the provider puts on a webhook: HMAC-SHA256 of its body, in lowercase hexadecimal. */
function signed(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('a statement with the settlements the balances count', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: DatabaseSync;
  let provider: Server;
  let providerUrl: string;
  let nextPayment: number;
  /** Applications started by a test beyond `app`, stopped after it. */
  const extra: Application[] = [];

  /** The provider's id of Ann's payout account, which the fixture sets; the fake provider knows every account. */
  const ANN_PAYOUT = 'acct_ann';

  beforeEach(async () => {
    directory = testDirectory();
    nextPayment = 1;
    // A fake provider: it knows every payout account, creates each payment, and makes each refund.
    provider = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => (raw += chunk));
      request.on('end', () => {
        const path = request.url ?? '';
        let status = 201;
        let body: unknown;
        if (path.startsWith('/accounts/')) {
          status = 200;
          body = { id: decodeURIComponent(path.slice(10)) };
        } else if (path.endsWith('/refunds')) {
          body = { id: 're_1' };
        } else {
          const n = nextPayment++;
          body = { id: `pay_${n}`, payUrl: `https://pay.example.org/${n}` };
        }
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    app = await createApplication({
      databasePath: directory.databasePath,
      providerUrl,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 200,
    });
    await app.start(0);
    // A second connection to the same file, to read what was stored.
    db = openDatabase(directory.databasePath);
  });

  afterEach(async () => {
    db.close();
    for (const other of extra.splice(0)) await other.stop();
    await app.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    provider.closeAllConnections();
    directory.remove();
  });

  /** Creates a group as `token`'s account and answers its id. */
  async function createGroup(token: string): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Flat', currency: 'EUR' } });
    if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Makes the account of `joinerToken` a member of `groupId`, through an invitation its owner creates. */
  async function join(ownerToken: string, groupId: string, joinerToken: string): Promise<void> {
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ownerToken });
    const id = (invitation.body as { id: string }).id;
    const accepted = await send(app, 'POST', `/invitations/${id}/accept`, { token: joinerToken });
    if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
  }

  /** Records an expense equally split between `splitBetween`, as `token`'s account; answers its id. */
  async function record(
    token: string,
    groupId: string,
    description: string,
    amount: number,
    splitBetween: string[],
    date = utcDay(0),
  ): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description, amount, date, splitBetween },
    });
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Ann and Ben in a group, Ann having paid a dinner of 3000 split equally: Ben owes Ann 1500. */
  async function annAndBenOwing1500() {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    const dinner = await record(ann.token, groupId, 'Dinner', 3000, [ann.id, ben.id]);
    // Ann is the one paid through the provider, so she has a payout account.
    const payout = await send(app, 'PUT', '/accounts/me/payout-account', {
      token: ann.token,
      body: { accountId: ANN_PAYOUT },
    });
    if (payout.status !== 204) throw new Error(`payout account answered ${payout.status}`);
    return { ann, ben, groupId, dinner };
  }

  /** The statement of `memberId` in `groupId`, read as `token`'s account. */
  async function statementAs(token: string, groupId: string, memberId: string) {
    return send(app, 'GET', `/groups/${groupId}/members/${memberId}/statement`, { token });
  }

  /** The balance of each member of `groupId`, read as `token`'s account, as a map from member to balance. */
  async function balancesAs(token: string, groupId: string): Promise<Record<string, number>> {
    const reply = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    const rows = reply.body as { memberId: string; balance: number }[];
    return Object.fromEntries(rows.map(row => [row.memberId, row.balance]));
  }

  /** Settles in cash, recorded by `payeeToken`'s account, the money paid by `from`; answers the settlement's id. */
  async function settleInCash(payeeToken: string, groupId: string, from: string, amount: number): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: payeeToken,
      body: { from, amount },
    });
    if (reply.status !== 201) throw new Error(`cash settlement answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Asks the provider for a payment of `amount` from `payerToken`'s account to `to`; answers the settlement's id. */
  async function askToPay(payerToken: string, groupId: string, to: string, amount: number): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: payerToken,
      body: { to, amount },
    });
    if (reply.status !== 201) throw new Error(`provider settlement answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** The provider's id of the payment of the settlement `id`, as Tally keeps it. */
  function paymentOf(id: string): string {
    const row = db.prepare('SELECT provider_payment_id FROM settlements WHERE id = ?').get(id) as {
      provider_payment_id: string;
    };
    return row.provider_payment_id;
  }

  /** Sends the provider's signed webhook saying the payment `paymentId` has `status`; answers the status it gets. */
  async function providerSays(paymentId: string, status: string): Promise<number> {
    const body = JSON.stringify({ id: `evt_${paymentId}_${status}`, paymentId, status, at: new Date().toISOString() });
    const response = await fetch(`${app.address}/${app.apiPrefix}/provider/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'provider-signature': signed(body) },
      body,
    });
    return response.status;
  }

  /** Asserts that every member's statement balance is the balance the group gives them, and answers the balances. */
  async function expectStatementBalancesMatchGroup(token: string, groupId: string, memberIds: string[]) {
    const balances = await balancesAs(token, groupId);
    for (const memberId of memberIds) {
      const statement = (await statementAs(token, groupId, memberId)).body as { balance: number };
      expect(statement.balance).toBe(balances[memberId]);
    }
    return balances;
  }

  it('lists a settlement in cash beside the expenses, from when it is recorded, paid for its payer and shared by its payee', async () => {
    const { ann, ben, groupId, dinner } = await annAndBenOwing1500();
    const settlement = await settleInCash(ann.token, groupId, ben.id, 1000);
    const asBen = await statementAs(ben.token, groupId, ben.id);
    expect(asBen.body).toEqual({
      memberId: ben.id,
      balance: -500,
      entries: [
        {
          kind: 'expense',
          expenseId: dinner,
          date: utcDay(0),
          description: 'Dinner',
          paid: 0,
          share: 1500,
          balance: -1500,
        },
        {
          kind: 'settlement',
          settlementId: settlement,
          date: utcDay(0),
          description: 'Settlement in cash',
          paid: 1000,
          share: 0,
          balance: -500,
        },
      ],
    });
    expect((await statementAs(ann.token, groupId, ann.id)).body).toEqual({
      memberId: ann.id,
      balance: 500,
      entries: [
        {
          kind: 'expense',
          expenseId: dinner,
          date: utcDay(0),
          description: 'Dinner',
          paid: 3000,
          share: 1500,
          balance: 1500,
        },
        {
          kind: 'settlement',
          settlementId: settlement,
          date: utcDay(0),
          description: 'Settlement in cash',
          paid: 0,
          share: 1000,
          balance: 500,
        },
      ],
    });
  });

  it('lists a settlement through the provider only once it is paid, from the day the balances started to count it', async () => {
    const { ann, ben, groupId, dinner } = await annAndBenOwing1500();
    const settlement = await askToPay(ben.token, groupId, ann.id, 500);
    // Pending, it is not counted: the statement is the expense alone, as the group's balance is.
    expect((await statementAs(ben.token, groupId, ben.id)).body).toMatchObject({
      balance: -1500,
      entries: [{ kind: 'expense', expenseId: dinner }],
    });

    expect(await providerSays(paymentOf(settlement), 'succeeded')).toBe(204);
    const read = (await send(app, 'GET', `/settlements/${settlement}`, { token: ben.token })).body as {
      history: { status: string; at: string }[];
    };
    const paidAt = read.history.find(change => change.status === 'paid')?.at;
    expect(paidAt).toBeDefined();
    const asBen = (await statementAs(ben.token, groupId, ben.id)).body as {
      balance: number;
      entries: unknown[];
    };
    expect(asBen).toEqual({
      memberId: ben.id,
      balance: -1000,
      entries: [
        {
          kind: 'expense',
          expenseId: dinner,
          date: utcDay(0),
          description: 'Dinner',
          paid: 0,
          share: 1500,
          balance: -1500,
        },
        {
          kind: 'settlement',
          settlementId: settlement,
          date: (paidAt as string).slice(0, 10),
          description: 'Settlement through the provider',
          paid: 500,
          share: 0,
          balance: -1000,
        },
      ],
    });
    await expectStatementBalancesMatchGroup(ben.token, groupId, [ben.id, ann.id]);
  });

  it('leaves out a settlement through the provider that failed, and counts it in no balance', async () => {
    const { ann, ben, groupId, dinner } = await annAndBenOwing1500();
    const failed = await askToPay(ben.token, groupId, ann.id, 500);
    expect(await providerSays(paymentOf(failed), 'failed')).toBe(204);
    const statement = (await statementAs(ben.token, groupId, ben.id)).body as { balance: number; entries: unknown[] };
    expect(statement.entries).toEqual([
      {
        kind: 'expense',
        expenseId: dinner,
        date: utcDay(0),
        description: 'Dinner',
        paid: 0,
        share: 1500,
        balance: -1500,
      },
    ]);
    expect(statement.balance).toBe(-1500);
    await expectStatementBalancesMatchGroup(ben.token, groupId, [ben.id, ann.id]);
  });

  it('keeps a settlement being refunded in the statement, and leaves it out once the provider says it is refunded', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const settlement = await askToPay(ben.token, groupId, ann.id, 500);
    expect(await providerSays(paymentOf(settlement), 'succeeded')).toBe(204);
    const refund = await send(app, 'POST', `/settlements/${settlement}/refund`, { token: ann.token });
    expect(refund.status).toBe(204);
    const refunding = (await statementAs(ben.token, groupId, ben.id)).body as { balance: number; entries: unknown[] };
    expect(refunding.entries).toContainEqual(
      expect.objectContaining({ kind: 'settlement', settlementId: settlement, paid: 500, share: 0 }),
    );
    expect(refunding.balance).toBe(-1000);

    expect(await providerSays(paymentOf(settlement), 'refunded')).toBe(204);
    expect((await statementAs(ben.token, groupId, ben.id)).body).toMatchObject({ balance: -1500 });
    expect(((await statementAs(ben.token, groupId, ben.id)).body as { entries: unknown[] }).entries).toHaveLength(1);
    await expectStatementBalancesMatchGroup(ben.token, groupId, [ben.id, ann.id]);
  });

  it('lists a settlement after an earlier-dated expense, and before an expense of its own day recorded after it', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    const earlier = await record(ann.token, groupId, 'Last week', 1000, [ann.id, ben.id], utcDay(-7));
    const settlement = await settleInCash(ann.token, groupId, ben.id, 300);
    const later = await record(ann.token, groupId, 'Today, after', 400, [ann.id, ben.id], utcDay(0));
    const entries = (
      (await statementAs(ben.token, groupId, ben.id)).body as {
        entries: { kind: string; expenseId?: string; settlementId?: string }[];
      }
    ).entries;
    expect(entries.map(entry => entry.expenseId ?? entry.settlementId)).toEqual([earlier, settlement, later]);
    expect(entries.map(entry => entry.kind)).toEqual(['expense', 'settlement', 'expense']);
  });

  it('answers the statement’s balance as the group’s, with cash and the provider settlements together', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    await settleInCash(ann.token, groupId, ben.id, 400);
    const pending = await askToPay(ben.token, groupId, ann.id, 300);
    await expectStatementBalancesMatchGroup(ben.token, groupId, [ben.id, ann.id]);
    expect(await providerSays(paymentOf(pending), 'succeeded')).toBe(204);
    const balances = await expectStatementBalancesMatchGroup(ben.token, groupId, [ben.id, ann.id]);
    expect(balances).toEqual({ [ann.id]: 800, [ben.id]: -800 });
  });

  /** The statement of `memberId` as CSV, read as `token`'s account (no account when `token` is undefined). */
  async function csvAs(token: string | undefined, groupId: string, memberId: string) {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const response = await fetch(
      `${app.address}/${app.apiPrefix}/groups/${groupId}/members/${memberId}/statement.csv`,
      { headers },
    );
    return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() };
  }

  it('answers the statement as CSV in UTF-8: a header line, then a CRLF line for each entry, in the statement’s order', async () => {
    const { ann, ben, groupId, dinner } = await annAndBenOwing1500();
    const settlement = await settleInCash(ann.token, groupId, ben.id, 1000);
    const reply = await csvAs(ben.token, groupId, ben.id);
    expect(reply.status).toBe(200);
    expect(reply.contentType).toBe('text/csv; charset=utf-8');
    expect(reply.text).toBe(
      `${HEADER}${utcDay(0)},expense,${dinner},Dinner,0,1500,-1500\r\n` +
        `${utcDay(0)},settlement,${settlement},Settlement in cash,1000,0,-500\r\n`,
    );
  });

  it('answers the header alone for a statement with no entries', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    const reply = await csvAs(ben.token, groupId, ben.id);
    expect(reply.status).toBe(200);
    expect(reply.text).toBe(HEADER);
  });

  it('quotes a field holding a comma, a double quote or a line break, doubling its double quotes, and no other field', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    const id = await record(ann.token, groupId, 'Pasta, "fresh"\nfor two', 1000, [ann.id, ben.id]);
    const reply = await csvAs(ben.token, groupId, ben.id);
    expect(reply.text).toBe(`${HEADER}${utcDay(0)},expense,${id},"Pasta, ""fresh""\nfor two",0,500,-500\r\n`);
  });

  it('lets the members read the statement of a member who left, refuses an outsider with 404 and a request with no token with 401', async () => {
    const { ann, ben, groupId, dinner } = await annAndBenOwing1500();
    const cleo = await signedUpAccount(app, { email: 'cleo@example.org', name: 'Cleo' });
    const settlement = await settleInCash(ann.token, groupId, ben.id, 1500);
    expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token })).status).toBe(204);

    const reply = await csvAs(ann.token, groupId, ben.id);
    expect(reply.status).toBe(200);
    expect(reply.text).toBe(
      `${HEADER}${utcDay(0)},expense,${dinner},Dinner,0,1500,-1500\r\n` +
        `${utcDay(0)},settlement,${settlement},Settlement in cash,1500,0,0\r\n`,
    );
    const outsider = await csvAs(cleo.token, groupId, ben.id);
    expect(outsider.status).toBe(404);
    expect((await csvAs(undefined, groupId, ben.id)).status).toBe(401);
  });
});
