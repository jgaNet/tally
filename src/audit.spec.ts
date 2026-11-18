import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApplication, type Application } from './app';
import { openDatabase } from './database';
import { ensureDatabase, send, signedUpAccount, testDirectory, type Reply, type TestDirectory } from './test-helpers';

const SECRET = 'shared with the provider';
const START = Date.parse('2026-11-10T09:00:00.000Z');
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

interface Member {
  id: string;
  token: string;
}

/** One entry of an audit, as a member reads it. */
interface Entry {
  id: string;
  at: string;
  by: string;
  action: string;
  subjectId: string;
  amount: number;
}

function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The signature the provider puts on a webhook: HMAC-SHA256 of its body, in lowercase hexadecimal. */
function signed(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function listening(server: Server): Promise<string> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

/** Answers `reply` when it is `status`; otherwise says what the setup got instead, so a failing setup reads plainly. */
function must(reply: Reply, status: number): Reply {
  if (reply.status !== status) throw new Error(`answered ${reply.status}: ${JSON.stringify(reply.body)}`);
  return reply;
}

/** The rows of the audit table of the database at `url`, as the database holds them now. */
async function auditRowsOf(url: string): Promise<unknown[]> {
  const db = await openDatabase({ url });
  try {
    return await db.prepare('SELECT * FROM audit_entries ORDER BY seq').all();
  } finally {
    await db.close();
  }
}

describe('the audit of a group', () => {
  let directory: TestDirectory;
  let app: Application;
  /** The time the application's clock tells; the background job runs at it. */
  let now: number;
  let providerServer: Server;
  let providerUrl: string;
  let nextPayment: number;
  let nextEvent: number;
  /** Applications started by a test beyond `app`, stopped after it. */
  const extra: Application[] = [];

  /** The application, started over the test's file with the fake provider. */
  async function startApp(): Promise<Application> {
    await ensureDatabase(directory.databaseUrl);
    const started = await createApplication({
      databaseUrl: directory.databaseUrl,
      providerUrl,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 1000,
      clock: () => new Date(now),
    });
    await started.start(0);
    return started;
  }

  beforeEach(async () => {
    directory = testDirectory();
    now = START;
    nextPayment = 1;
    nextEvent = 1;
    // The provider knows every account, creates a payment `pay_N` and a refund `re_1`.
    providerServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      let raw = '';
      request.on('data', chunk => (raw += chunk));
      request.on('end', () => {
        const path = request.url ?? '';
        if (path.startsWith('/accounts/')) {
          answer(response, 200, { id: decodeURIComponent(path.slice('/accounts/'.length)) });
        } else if (path.endsWith('/refunds')) {
          answer(response, 201, { id: 're_1' });
        } else {
          const n = nextPayment++;
          answer(response, 201, { id: `pay_${n}`, payUrl: `https://pay.example.org/${n}` });
        }
      });
    });
    providerUrl = await listening(providerServer);
    app = await startApp();
  });

  afterEach(async () => {
    for (const other of extra.splice(0)) await other.stop();
    await app.stop();
    await new Promise<void>(resolve => providerServer.close(() => resolve()));
    providerServer.closeAllConnections();
    await directory.remove();
  });

  async function member(name: string, email: string): Promise<Member> {
    return signedUpAccount(app, { email, name });
  }

  /** A group of `owner`, with `members` joined through invitations, answering its id. */
  async function groupWith(owner: Member, members: Member[]): Promise<string> {
    const created = must(
      await send(app, 'POST', '/groups', { token: owner.token, body: { name: 'Trip', currency: 'EUR' } }),
      201,
    );
    const groupId = (created.body as { id: string }).id;
    for (const joiner of members) await joinGroup(groupId, owner, joiner);
    return groupId;
  }

  async function joinGroup(groupId: string, owner: Member, joiner: Member): Promise<void> {
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: owner.token });
    const id = (invitation.body as { id: string }).id;
    must(await send(app, 'POST', `/invitations/${id}/accept`, { token: joiner.token }), 204);
  }

  /** `payer` records an expense of `amount` split equally between `between`; answers its id. */
  async function record(groupId: string, payer: Member, between: Member[], amount: number): Promise<string> {
    const reply = must(
      await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: payer.token,
        body: { description: 'Dinner', amount, date: utcDay(0), splitBetween: between.map(m => m.id) },
      }),
      201,
    );
    return (reply.body as { id: string }).id;
  }

  /** The audit of `groupId` as `token`'s account reads it. */
  async function auditAs(token: string | undefined, groupId: string): Promise<Reply> {
    return send(app, 'GET', `/groups/${groupId}/audit`, { token });
  }

  async function entriesOf(token: string, groupId: string): Promise<Entry[]> {
    return must(await auditAs(token, groupId), 200).body as Entry[];
  }

  /** A payout account for `payee`, which a settlement through the provider pays to. */
  async function payoutAccount(payee: Member): Promise<void> {
    must(
      await send(app, 'PUT', '/accounts/me/payout-account', {
        token: payee.token,
        body: { accountId: `acct_${payee.id}` },
      }),
      204,
    );
  }

  /** Asks the provider for a payment of `amount` from `payer` to `payee`; answers the settlement's id. */
  async function askToPay(groupId: string, payer: Member, payee: Member, amount: number): Promise<string> {
    const reply = must(
      await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: payer.token,
        body: { to: payee.id, amount },
      }),
      201,
    );
    return (reply.body as { id: string }).id;
  }

  /** Sends the provider's signed webhook about `paymentId` with `status` to `server`; answers its status. */
  async function webhook(paymentId: string, status: string, server: Application = app): Promise<number> {
    const body = JSON.stringify({ id: `evt_${nextEvent++}`, paymentId, status, at: new Date().toISOString() });
    const response = await fetch(`${server.address}/${server.apiPrefix}/provider/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'provider-signature': signed(body) },
      body,
    });
    return response.status;
  }

  /** The entries of `entries` whose action is `action`. */
  const ofAction = (entries: Entry[], action: string) => entries.filter(entry => entry.action === action);

  it('records an expense as recorded by its payer, with its amount, and the expense as its subject', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    const before = Date.now();
    const expenseId = await record(groupId, ben, [ana, ben], 3000);
    const entries = await entriesOf(ana.token, groupId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: expect.any(String),
      at: expect.stringMatching(ISO_INSTANT),
      by: ben.id,
      action: 'expense-recorded',
      subjectId: expenseId,
      amount: 3000,
    });
    const at = Date.parse(entries[0].at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('records a recurring expense the background job records, as recorded by its payer, at the time of the job', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    must(
      await send(app, 'POST', `/groups/${groupId}/recurring`, {
        token: ben.token,
        body: { description: 'Rent', amount: 1001, startsOn: '2026-11-05', splitBetween: [ana.id, ben.id] },
      }),
      201,
    );
    expect(await entriesOf(ana.token, groupId)).toEqual([]);
    await app.runJobs();
    const expenses = must(await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ana.token }), 200).body as {
      id: string;
    }[];
    expect(expenses).toHaveLength(1);
    expect(await entriesOf(ana.token, groupId)).toEqual([
      {
        id: expect.any(String),
        at: new Date(START).toISOString(),
        by: ben.id,
        action: 'expense-recorded',
        subjectId: expenses[0].id,
        amount: 1001,
      },
    ]);
  });

  it('records an edit as made by its editor, with the amount the expense has after it', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    const expenseId = await record(groupId, ben, [ana, ben], 3000);
    must(
      await send(app, 'PUT', `/expenses/${expenseId}`, {
        token: ana.token,
        body: { description: 'Dinner', amount: 2000, date: utcDay(0), splitBetween: [ana.id, ben.id], version: 1 },
      }),
      200,
    );
    const edited = ofAction(await entriesOf(ana.token, groupId), 'expense-edited');
    expect(edited).toEqual([
      {
        id: expect.any(String),
        at: expect.stringMatching(ISO_INSTANT),
        by: ana.id,
        action: 'expense-edited',
        subjectId: expenseId,
        amount: 2000,
      },
    ]);
  });

  it('records a deletion as made by its deleter, with the amount the expense had, and keeps every entry once it is gone', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    const expenseId = await record(groupId, ben, [ana, ben], 3000);
    must(
      await send(app, 'PUT', `/expenses/${expenseId}`, {
        token: ben.token,
        body: { description: 'Dinner', amount: 2000, date: utcDay(0), splitBetween: [ana.id, ben.id], version: 1 },
      }),
      200,
    );
    must(await send(app, 'DELETE', `/expenses/${expenseId}`, { token: ana.token }), 204);
    expect(must(await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ana.token }), 200).body).toEqual([]);
    const entries = await entriesOf(ana.token, groupId);
    expect(entries.map(entry => [entry.action, entry.by, entry.subjectId, entry.amount])).toEqual([
      ['expense-recorded', ben.id, expenseId, 3000],
      ['expense-edited', ben.id, expenseId, 2000],
      ['expense-deleted', ana.id, expenseId, 2000],
    ]);
  });

  it('records a settlement in cash as paid by its payee, who records it, and its amount', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    await record(groupId, ben, [ana, ben], 3000);
    must(
      await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: ben.token,
        body: { from: ana.id, amount: 1500 },
      }),
      201,
    );
    const paid = ofAction(await entriesOf(ana.token, groupId), 'settlement-paid');
    expect(paid).toEqual([
      {
        id: expect.any(String),
        at: expect.stringMatching(ISO_INSTANT),
        by: ben.id,
        action: 'settlement-paid',
        subjectId: expect.any(String),
        amount: 1500,
      },
    ]);
  });

  it('records a settlement through the provider as paid by its payer only once the provider says it succeeded', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    await record(groupId, ben, [ana, ben], 3000);
    await payoutAccount(ben);
    const settlementId = await askToPay(groupId, ana, ben, 1500);
    // Asked for and pending: no entry, and the balances do not count it yet.
    expect(ofAction(await entriesOf(ana.token, groupId), 'settlement-paid')).toEqual([]);
    expect(await webhook('pay_1', 'succeeded')).toBe(204);
    expect(ofAction(await entriesOf(ana.token, groupId), 'settlement-paid')).toEqual([
      {
        id: expect.any(String),
        at: expect.stringMatching(ISO_INSTANT),
        by: ana.id,
        action: 'settlement-paid',
        subjectId: settlementId,
        amount: 1500,
      },
    ]);
  });

  it('records nothing for a payment that fails', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    await record(groupId, ben, [ana, ben], 3000);
    await payoutAccount(ben);
    await askToPay(groupId, ana, ben, 1500);
    expect(await webhook('pay_1', 'failed')).toBe(204);
    expect(await entriesOf(ana.token, groupId)).toHaveLength(1);
  });

  it('records a refund once the provider says it is refunded, as made by the payee, and nothing while it is only asked', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    await record(groupId, ben, [ana, ben], 3000);
    await payoutAccount(ben);
    const settlementId = await askToPay(groupId, ana, ben, 1500);
    await webhook('pay_1', 'succeeded');
    must(await send(app, 'POST', `/settlements/${settlementId}/refund`, { token: ben.token }), 204);
    // Asked of the provider, the refund is refunding: the balances still count the payment, and no entry is written.
    expect(ofAction(await entriesOf(ben.token, groupId), 'settlement-refunded')).toEqual([]);
    expect(await webhook('pay_1', 'refunded')).toBe(204);
    const refunded = ofAction(await entriesOf(ben.token, groupId), 'settlement-refunded');
    expect(refunded).toEqual([
      {
        id: expect.any(String),
        at: expect.stringMatching(ISO_INSTANT),
        by: ben.id,
        action: 'settlement-refunded',
        subjectId: settlementId,
        amount: 1500,
      },
    ]);
    expect((await entriesOf(ben.token, groupId)).map(entry => entry.action)).toEqual([
      'expense-recorded',
      'settlement-paid',
      'settlement-refunded',
    ]);
  });

  it('records nothing for a refund of a payment that never succeeded: it never counted in the balances', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    await record(groupId, ben, [ana, ben], 3000);
    await payoutAccount(ben);
    await askToPay(groupId, ana, ben, 1500);
    expect(await webhook('pay_1', 'refunded')).toBe(204);
    expect(await entriesOf(ana.token, groupId)).toHaveLength(1);
  });

  it('records a change once however many times its webhook arrives, and however many servers receive it', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    await record(groupId, ben, [ana, ben], 3000);
    await payoutAccount(ben);
    await askToPay(groupId, ana, ben, 1500);
    const other = await startApp();
    extra.push(other);
    // The same success, said to two servers on the same file at the same moment, and then again.
    const body = JSON.stringify({
      id: 'evt_same',
      paymentId: 'pay_1',
      status: 'succeeded',
      at: new Date().toISOString(),
    });
    const deliver = (server: Application) =>
      fetch(`${server.address}/${server.apiPrefix}/provider/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'provider-signature': signed(body) },
        body,
      }).then(response => response.status);
    expect(await Promise.all([deliver(app), deliver(other)])).toEqual([204, 204]);
    expect(await deliver(app)).toBe(204);
    expect(ofAction(await entriesOf(ana.token, groupId), 'settlement-paid')).toHaveLength(1);
  });

  it('records a balance passed on when a member with a balance leaves, as they left, positive or negative, and nothing for 0', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const cy = await member('Cy', 'cy@example.org');
    const dee = await member('Dee', 'dee@example.org');
    const groupId = await groupWith(ana, [ben, cy, dee]);
    // Ben paid 3000 for Ana, Ben and Cy: Ben is owed 2000, Cy owes 1000, and Dee, who is not in it, has 0.
    await record(groupId, ben, [ana, ben, cy], 3000);

    must(await send(app, 'POST', `/groups/${groupId}/leave`, { token: dee.token }), 204);
    expect(await entriesOf(ana.token, groupId)).toHaveLength(1);

    must(await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token }), 204);
    must(await send(app, 'POST', `/groups/${groupId}/leave`, { token: cy.token }), 204);
    expect(ofAction(await entriesOf(ana.token, groupId), 'balance-passed')).toEqual([
      {
        id: expect.any(String),
        at: expect.stringMatching(ISO_INSTANT),
        by: ben.id,
        action: 'balance-passed',
        subjectId: ben.id,
        amount: 2000,
      },
      {
        id: expect.any(String),
        at: expect.stringMatching(ISO_INSTANT),
        by: cy.id,
        action: 'balance-passed',
        subjectId: cy.id,
        amount: -1000,
      },
    ]);
  });

  it('records nothing when a member joins again: what they passed on stays as it was, and no change of money is made', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    await record(groupId, ben, [ana, ben], 3000);
    must(await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token }), 204);
    await joinGroup(groupId, ana, ben);
    expect((await entriesOf(ana.token, groupId)).map(entry => entry.action)).toEqual([
      'expense-recorded',
      'balance-passed',
    ]);
  });

  it('records nothing for a change refused: a stale edit, a delete by a member who is neither payer nor owner, a cash settlement of more than is owed, the owner leaving', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const cy = await member('Cy', 'cy@example.org');
    const groupId = await groupWith(ana, [ben, cy]);
    const expenseId = await record(groupId, ben, [ana, ben], 3000);
    const before = await entriesOf(ana.token, groupId);

    const stale = await send(app, 'PUT', `/expenses/${expenseId}`, {
      token: ben.token,
      body: { description: 'Dinner', amount: 2000, date: utcDay(0), splitBetween: [ana.id, ben.id], version: 7 },
    });
    expect(stale.status).toBe(409);
    expect((await send(app, 'DELETE', `/expenses/${expenseId}`, { token: cy.token })).status).toBe(403);
    const tooMuch = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: ben.token,
      body: { from: ana.id, amount: 2000 },
    });
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect(tooMuch.status).toBeLessThan(500);
    expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ana.token })).status).toBe(403);

    expect(await entriesOf(ana.token, groupId)).toEqual(before);
  });

  it('reads the audit oldest first, to a member of the group', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const cy = await member('Cy', 'cy@example.org');
    const groupId = await groupWith(ana, [ben, cy]);
    const expenseId = await record(groupId, ben, [ana, ben], 3000);
    must(
      await send(app, 'PUT', `/expenses/${expenseId}`, {
        token: ana.token,
        body: { description: 'Dinner', amount: 2000, date: utcDay(0), splitBetween: [ana.id, ben.id], version: 1 },
      }),
      200,
    );
    must(await send(app, 'DELETE', `/expenses/${expenseId}`, { token: ben.token }), 204);

    // Read by a member who joined last, as the same audit every member reads.
    const entries = await entriesOf(cy.token, groupId);
    expect(entries.map(entry => entry.action)).toEqual(['expense-recorded', 'expense-edited', 'expense-deleted']);
    expect(entries.map(entry => entry.amount)).toEqual([3000, 2000, 2000]);
    const times = entries.map(entry => Date.parse(entry.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(await entriesOf(ana.token, groupId)).toEqual(entries);
  });

  it('refuses the audit to anyone else, and to someone who has left, as if the group did not exist; and to no one who is not signed in', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const dee = await member('Dee', 'dee@example.org');
    const groupId = await groupWith(ana, [ben]);
    await record(groupId, ben, [ana, ben], 3000);
    must(await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token }), 204);

    expect((await auditAs(dee.token, groupId)).status).toBe(404);
    expect((await auditAs(ben.token, groupId)).status).toBe(404);
    expect((await auditAs(ana.token, '00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await auditAs(undefined, groupId)).status).toBe(401);
  });

  it('keeps every entry when the server is stopped and started again on the same file', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    await record(groupId, ben, [ana, ben], 3000);
    const before = await entriesOf(ana.token, groupId);
    await app.stop();
    app = await startApp();
    expect(await entriesOf(ana.token, groupId)).toEqual(before);
    expect(before).toHaveLength(1);
  });

  it('writes one entry per change when two servers on the same file record changes at the same moment', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    const other = await startApp();
    extra.push(other);
    const reply = (server: Application) =>
      send(server, 'POST', `/groups/${groupId}/expenses`, {
        token: ben.token,
        body: { description: 'Dinner', amount: 3000, date: utcDay(0), splitBetween: [ana.id, ben.id] },
      });
    const replies = await Promise.all([reply(app), reply(other), reply(app)]);
    expect(replies.map(r => r.status)).toEqual([201, 201, 201]);
    expect(ofAction(await entriesOf(ana.token, groupId), 'expense-recorded')).toHaveLength(3);
  });

  it('changes nothing when it is read', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const ben = await member('Ben', 'ben@example.org');
    const groupId = await groupWith(ana, [ben]);
    await record(groupId, ben, [ana, ben], 3000);
    const stored = await auditRowsOf(directory.databaseUrl);
    await entriesOf(ana.token, groupId);
    await entriesOf(ben.token, groupId);
    expect(await auditRowsOf(directory.databaseUrl)).toEqual(stored);
  });

  it('keeps the audit of an archived group, which stays readable', async () => {
    const ana = await member('Ana', 'ana@example.org');
    const groupId = await groupWith(ana, []);
    await record(groupId, ana, [ana], 1000);
    must(await send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token }), 204);
    const entries = await entriesOf(ana.token, groupId);
    expect(entries.map(entry => entry.action)).toEqual(['expense-recorded']);
  });
});
