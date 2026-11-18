import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { type Application, createApplication } from './app';
import { type Database, openDatabase } from './database';
import { createLegacyFile } from './legacy-file';
import {
  type TestDirectory,
  ensureDatabase,
  send,
  signedUpAccount,
  startApplication,
  testDirectory,
} from './test-helpers';

const SECRET = 'shared with the provider';
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The signature the provider puts on a webhook: HMAC-SHA256 of its body, in lowercase hexadecimal. */
function signed(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('the settlements of a group, with the history of each', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: Database;
  let provider: Server;
  let providerUrl: string;
  let nextPayment: number;
  let nextEvent: number;

  /** The provider's id of Ann's payout account, which the fixture sets. */
  const ANN_PAYOUT = 'acct_ann';

  /** Starts an application on the file of this test, as Tally starts again after it was stopped. */
  async function startedOnFile(): Promise<Application> {
    await ensureDatabase(directory.databaseUrl);
    const started = await createApplication({
      databaseUrl: directory.databaseUrl,
      providerUrl,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 200,
    });
    await started.start(0);
    return started;
  }

  beforeEach(async () => {
    directory = testDirectory();
    nextPayment = 1;
    nextEvent = 1;
    provider = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => (raw += chunk));
      request.on('end', () => {
        const path = request.url ?? '';
        let status = 201;
        let body: unknown;
        if (path.startsWith('/accounts/')) {
          status = 200;
          body = { id: decodeURIComponent(path.slice('/accounts/'.length)) };
        } else if (path.endsWith('/refunds')) {
          body = { id: 're_1' };
        } else {
          const n = nextPayment++;
          body = { id: `pay_${n}`, payUrl: `https://pay.example.org/${n}`, fee: 0 };
        }
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    app = await startedOnFile();
    // A second connection to the same file, to count what was stored.
    db = await openDatabase({ url: directory.databaseUrl });
  });

  afterEach(async () => {
    await db.close();
    await app.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    provider.closeAllConnections();
    await directory.remove();
  });

  /** Creates a group as `token`'s account and answers its id. */
  async function createGroup(token: string): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Trip', currency: 'EUR' } });
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

  /**
   * Ann and Ben in a group: Ann paid 3000 split equally, so Ben owes Ann 1500. Ann has a payout account, so Ben can
   * pay her through the provider.
   */
  async function annAndBen() {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
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
    return { ann, ben, groupId };
  }

  /** Ann records that Ben paid her `amount` in cash. */
  async function cashFromBen(annToken: string, groupId: string, benId: string, amount: number): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: annToken,
      body: { from: benId, amount },
    });
    if (reply.status !== 201) throw new Error(`cash answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Ben asks the provider for a payment of `amount` to Ann. */
  async function askToPay(benToken: string, groupId: string, annId: string, amount: number): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: benToken,
      body: { to: annId, amount },
    });
    if (reply.status !== 201) throw new Error(`ask answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** The provider's id of the payment of the settlement `id`, as Tally keeps it. */
  async function paymentOf(id: string): Promise<string> {
    return (
      (await db.prepare('SELECT provider_payment_id FROM settlements WHERE id = ?').get(id)) as {
        provider_payment_id: string;
      }
    ).provider_payment_id;
  }

  /** The provider says the payment `paymentId` is `status`, in a webhook signed by it, and expects it acknowledged. */
  async function say(paymentId: string, status: string): Promise<void> {
    const body = JSON.stringify({
      id: `evt_${nextEvent++}`,
      paymentId,
      status,
      at: new Date().toISOString(),
    });
    const response = await fetch(`${app.address}/${app.apiPrefix}/provider/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'provider-signature': signed(body) },
      body,
    });
    expect(response.status).toBe(204);
  }

  /** The settlements of `groupId`, as `token`'s account lists them. */
  async function listAs(token: string, groupId: string) {
    return send(app, 'GET', `/groups/${groupId}/settlements`, { token });
  }

  /** The statuses of a settlement, the earliest first. */
  function statusesOf(settlement: { history: { status: string }[] }): string[] {
    return settlement.history.map(change => change.status);
  }

  it('answers an empty list for a group with no settlements', async () => {
    const { ann, groupId } = await annAndBen();
    expect(await listAs(ann.token, groupId)).toEqual({ status: 200, body: [] });
  });

  it('lists the most recently recorded or asked for first, whatever the later statuses of each', async () => {
    const { ann, ben, groupId } = await annAndBen();
    const first = await cashFromBen(ann.token, groupId, ben.id, 500);
    const second = await askToPay(ben.token, groupId, ann.id, 400);
    const third = await askToPay(ben.token, groupId, ann.id, 600);
    // A webhook moves the older payment on; the order stays the order they were recorded in.
    await say(await paymentOf(second), 'succeeded');

    const listed = await listAs(ann.token, groupId);
    expect(listed.status).toBe(200);
    expect((listed.body as { id: string }[]).map(settlement => settlement.id)).toEqual([third, second, first]);
  });

  it('lists every settlement of the group, pending and failed ones too, each as GET /v1/settlements/{id} reads it', async () => {
    const { ann, ben, groupId } = await annAndBen();
    const cash = await cashFromBen(ann.token, groupId, ben.id, 500);
    const failed = await askToPay(ben.token, groupId, ann.id, 400);
    const pending = await askToPay(ben.token, groupId, ann.id, 600);
    await say(await paymentOf(failed), 'failed');

    const listed = (await listAs(ann.token, groupId)).body as { id: string }[];
    expect(listed.map(settlement => settlement.id)).toEqual([pending, failed, cash]);
    for (const settlement of listed) {
      expect(settlement).toEqual((await send(app, 'GET', `/settlements/${settlement.id}`, { token: ben.token })).body);
    }
    expect(listed.find(settlement => settlement.id === pending)).toMatchObject({
      status: 'pending',
      method: 'provider',
      payUrl: expect.stringMatching(/^https:\/\/pay\.example\.org\//),
    });
  });

  it('answers the same list to every member of the group', async () => {
    const { ann, ben, groupId } = await annAndBen();
    await cashFromBen(ann.token, groupId, ben.id, 500);
    expect((await listAs(ann.token, groupId)).body).toEqual((await listAs(ben.token, groupId)).body);
  });

  it('gives a cash settlement one status, paid, learned when it was recorded', async () => {
    const { ann, ben, groupId } = await annAndBen();
    const id = await cashFromBen(ann.token, groupId, ben.id, 500);
    const [settlement] = (await listAs(ann.token, groupId)).body as {
      id: string;
      at: string;
      history: { status: string; at: string }[];
    }[];
    expect(settlement.id).toBe(id);
    expect(settlement.history).toEqual([{ status: 'paid', at: settlement.at }]);
  });

  it('gives a payment through the provider every status it has had, the earliest first, each with when Tally learned it', async () => {
    const { ann, ben, groupId } = await annAndBen();
    const id = await askToPay(ben.token, groupId, ann.id, 1500);
    await say(await paymentOf(id), 'succeeded');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM settlement_statuses WHERE settlement_id = ?').get(id)).toEqual({
      n: 2,
    });

    const [settlement] = (await listAs(ann.token, groupId)).body as {
      history: { status: string; at: string }[];
    }[];
    expect(statusesOf(settlement)).toEqual(['pending', 'paid']);
    for (const change of settlement.history) expect(change.at).toMatch(ISO_TIME);
    const times = settlement.history.map(change => Date.parse(change.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('gives a failed payment pending, then failed', async () => {
    const { ann, ben, groupId } = await annAndBen();
    const id = await askToPay(ben.token, groupId, ann.id, 1500);
    await say(await paymentOf(id), 'failed');
    const [settlement] = (await listAs(ann.token, groupId)).body as { history: { status: string }[] }[];
    expect(statusesOf(settlement)).toEqual(['pending', 'failed']);
  });

  it('gives a refund every status it has had: pending, paid, refunding, then refunded', async () => {
    const { ann, ben, groupId } = await annAndBen();
    const id = await askToPay(ben.token, groupId, ann.id, 1500);
    const paymentId = await paymentOf(id);
    await say(paymentId, 'succeeded');
    expect((await send(app, 'POST', `/settlements/${id}/refund`, { token: ann.token })).status).toBe(204);
    await say(paymentId, 'refunded');

    const [settlement] = (await listAs(ann.token, groupId)).body as {
      status: string;
      history: { status: string; at: string }[];
    }[];
    expect(settlement.status).toBe('refunded');
    expect(statusesOf(settlement)).toEqual(['pending', 'paid', 'refunding', 'refunded']);
    for (const change of settlement.history) expect(change.at).toMatch(ISO_TIME);
  });

  it('adds only the status a webhook moves a settlement to, when that overtakes the ones it never had', async () => {
    const { ann, ben, groupId } = await annAndBen();
    const id = await askToPay(ben.token, groupId, ann.id, 1500);
    await say(await paymentOf(id), 'refunded');
    const [settlement] = (await listAs(ann.token, groupId)).body as { history: { status: string }[] }[];
    expect(statusesOf(settlement)).toEqual(['pending', 'refunded']);
  });

  it('adds nothing for a webhook that changes nothing', async () => {
    const { ann, ben, groupId } = await annAndBen();
    const id = await askToPay(ben.token, groupId, ann.id, 1500);
    const paymentId = await paymentOf(id);
    await say(paymentId, 'succeeded');
    await say(paymentId, 'succeeded');
    await say(paymentId, 'failed');
    await say(paymentId, 'pending');
    await say('pay_unknown', 'succeeded');

    const [settlement] = (await listAs(ann.token, groupId)).body as { history: { status: string }[] }[];
    expect(statusesOf(settlement)).toEqual(['pending', 'paid']);
  });

  it('lets a member who has left be seen by the members still in the group, with the settlements they made', async () => {
    const { ann, ben, groupId } = await annAndBen();
    const id = await cashFromBen(ann.token, groupId, ben.id, 1500);
    expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token })).status).toBe(204);

    const listed = await listAs(ann.token, groupId);
    expect(listed.status).toBe(200);
    expect((listed.body as { id: string; from: string }[]).map(settlement => settlement.id)).toEqual([id]);
    expect((listed.body as { from: string }[])[0].from).toBe(ben.id);
  });

  it('answers 404 to a member who has left, and to an account that is not a member, as for a group that does not exist', async () => {
    const { ann, ben, groupId } = await annAndBen();
    await cashFromBen(ann.token, groupId, ben.id, 1500);
    await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token });
    const outsider = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });

    const missing = await listAs(ann.token, '00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(await listAs(ben.token, groupId)).toEqual(missing);
    expect(await listAs(outsider.token, groupId)).toEqual(missing);
  });

  it('refuses a request with no token, or an unproven one, with 401', async () => {
    const { groupId } = await annAndBen();
    expect((await send(app, 'GET', `/groups/${groupId}/settlements`)).status).toBe(401);
    expect((await send(app, 'GET', `/groups/${groupId}/settlements`, { token: 'not-a-token' })).status).toBe(401);
  });

  it('changes nothing stored however often it is read', async () => {
    const { ann, ben, groupId } = await annAndBen();
    const id = await askToPay(ben.token, groupId, ann.id, 1500);
    await say(await paymentOf(id), 'succeeded');
    const count = async () =>
      ((await db.prepare('SELECT COUNT(*) AS n FROM settlement_statuses').get()) as { n: number }).n;
    const before = await count();
    for (let read = 0; read < 3; read++) {
      await listAs(ann.token, groupId);
      await send(app, 'GET', `/settlements/${id}`, { token: ben.token });
    }
    expect(await count()).toBe(before);
  });

  it('keeps every history across restarts, the same as before the restart', async () => {
    const { ann, ben, groupId } = await annAndBen();
    const id = await askToPay(ben.token, groupId, ann.id, 1500);
    await say(await paymentOf(id), 'succeeded');
    const before = (await listAs(ann.token, groupId)).body;

    await app.stop();
    app = await startedOnFile();
    expect((await listAs(ann.token, groupId)).body).toEqual(before);
  });

  it('gives the settlements of a file written before their history was kept the statuses they had, once, at the time they were recorded', async () => {
    const legacy = testDirectory();
    try {
      // A file as the application wrote it before the history: the settlements as they stand, and no history table
      // (createLegacyFile makes the file's tables; the history table is dropped, so the upgrade backfills it).
      createLegacyFile(legacy.legacyPath);
      const old = new DatabaseSync(legacy.legacyPath);
      try {
        old.exec(`
          DROP TABLE settlement_statuses;
          INSERT INTO accounts (id, email, email_key, name, password_hash, created_at) VALUES
            ('ann', 'ann@example.org', 'ann@example.org', 'Ann', 'hash', '2026-11-01T00:00:00.000Z'),
            ('ben', 'ben@example.org', 'ben@example.org', 'Ben', 'hash', '2026-11-01T00:00:00.000Z');
          INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES
            ('g1', 'Flat', 'EUR', 'ann', '2026-11-01T00:00:00.000Z');
          INSERT INTO settlements VALUES ('a_cash', 'g1', 'ben', 'ann', 700, 'cash', 'paid', NULL, NULL, '2026-11-01T10:00:00.000Z');
          INSERT INTO settlements VALUES ('b_pending', 'g1', 'ben', 'ann', 100, 'provider', 'pending', 'pay_1', 'https://pay.example.org/1', '2026-11-02T10:00:00.000Z');
          INSERT INTO settlements VALUES ('c_paid', 'g1', 'ben', 'ann', 100, 'provider', 'paid', 'pay_2', 'https://pay.example.org/2', '2026-11-03T10:00:00.000Z');
          INSERT INTO settlements VALUES ('d_refunding', 'g1', 'ben', 'ann', 100, 'provider', 'refunding', 'pay_3', 'https://pay.example.org/3', '2026-11-04T10:00:00.000Z');
          INSERT INTO settlements VALUES ('e_refunded', 'g1', 'ben', 'ann', 100, 'provider', 'refunded', 'pay_4', 'https://pay.example.org/4', '2026-11-05T10:00:00.000Z');
          INSERT INTO settlements VALUES ('f_failed', 'g1', 'ben', 'ann', 100, 'provider', 'failed', 'pay_5', 'https://pay.example.org/5', '2026-11-06T10:00:00.000Z');
        `);
      } finally {
        old.close();
      }

      const history = (database: Database) =>
        database.prepare('SELECT settlement_id, status, at FROM settlement_statuses ORDER BY settlement_id, seq').all();
      const expected = [
        { settlement_id: 'a_cash', status: 'paid', at: '2026-11-01T10:00:00.000Z' },
        { settlement_id: 'b_pending', status: 'pending', at: '2026-11-02T10:00:00.000Z' },
        { settlement_id: 'c_paid', status: 'pending', at: '2026-11-03T10:00:00.000Z' },
        { settlement_id: 'c_paid', status: 'paid', at: '2026-11-03T10:00:00.000Z' },
        { settlement_id: 'd_refunding', status: 'pending', at: '2026-11-04T10:00:00.000Z' },
        { settlement_id: 'd_refunding', status: 'paid', at: '2026-11-04T10:00:00.000Z' },
        { settlement_id: 'd_refunding', status: 'refunding', at: '2026-11-04T10:00:00.000Z' },
        { settlement_id: 'e_refunded', status: 'pending', at: '2026-11-05T10:00:00.000Z' },
        { settlement_id: 'e_refunded', status: 'refunded', at: '2026-11-05T10:00:00.000Z' },
        { settlement_id: 'f_failed', status: 'pending', at: '2026-11-06T10:00:00.000Z' },
        { settlement_id: 'f_failed', status: 'failed', at: '2026-11-06T10:00:00.000Z' },
      ];

      const first = await startApplication(legacy.databaseUrl, { databasePath: legacy.legacyPath });
      await first.stop();
      const upgraded = await openDatabase({ url: legacy.databaseUrl });
      try {
        expect(await history(upgraded)).toEqual(expected);
      } finally {
        await upgraded.close();
      }
      // A database that has its history is not backfilled again.
      const second = await startApplication(legacy.databaseUrl, { databasePath: legacy.legacyPath });
      await second.stop();
      const reopened = await openDatabase({ url: legacy.databaseUrl });
      try {
        expect(await history(reopened)).toEqual(expected);
      } finally {
        await reopened.close();
      }
    } finally {
      await legacy.remove();
    }
  });
});
