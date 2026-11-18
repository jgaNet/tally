import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { type Application, createApplication } from './app';
import { send, signedUpAccount, testDirectory, type Reply, type TestDirectory } from './test-helpers';

const SECRET = 'shared with the provider';
const START = Date.parse('2026-11-10T09:00:00.000Z');
const DAY = '2026-11-10';
const DAY_MS = 86_400_000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** The first bytes of a JPEG: enough for the receipt to be read as one. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

interface Member {
  id: string;
  token: string;
}

/** A group of the fixtures: its owner Ana, Ben and Cy (who joins later), and Dee, who is no member. */
interface Fixture {
  ana: Member;
  ben: Member;
  cy: Member;
  dee: Member;
  groupId: string;
  expenseId: string;
  recurringId: string;
  templateId: string;
  invitationId: string;
}

/** A call the fake provider received. */
interface ProviderCall {
  method: string;
  path: string;
  body: unknown;
}

/** Every row of every table of the file at `path`, as text: what a change to the file would alter. */
function dumpOf(path: string): string {
  const db = new DatabaseSync(path);
  try {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];
    return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  } finally {
    db.close();
  }
}

/** The row of a query of the file at `path`, as the file holds it now. */
function rowOf(path: string, sql: string, ...params: string[]): Record<string, unknown> {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(sql).get(...params) as Record<string, unknown>;
  } finally {
    db.close();
  }
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

function closed(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Answers `reply` when it is `status`; otherwise says what the setup got instead, so a failing setup reads plainly. */
function must(reply: Reply, status: number): Reply {
  if (reply.status !== status) throw new Error(`answered ${reply.status}: ${JSON.stringify(reply.body)}`);
  return reply;
}

describe('archiving a group', () => {
  let directory: TestDirectory;
  let app: Application;
  /** The time the application's clock tells; moved by the tests. */
  let now: number;
  let providerServer: Server;
  let providerUrl: string;
  let storeServer: Server;
  let receiptsUrl: string;
  let providerCalls: ProviderCall[];
  let storeCalls: number;
  let nextPayment: number;
  let nextRefund: number;

  /** The application, started over the test's file with the fake provider and receipts store. */
  async function startApp(): Promise<Application> {
    const started = await createApplication({
      databasePath: directory.databasePath,
      providerUrl,
      providerWebhookSecret: SECRET,
      receiptsUrl,
      clock: () => new Date(now),
    });
    await started.start(0);
    return started;
  }

  beforeEach(async () => {
    directory = testDirectory();
    now = START;
    providerCalls = [];
    storeCalls = 0;
    nextPayment = 1;
    nextRefund = 1;
    // The provider: it knows every account, creates a payment `pay_N` and a refund `re_N`.
    providerServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      let raw = '';
      request.on('data', chunk => (raw += chunk));
      request.on('end', () => {
        const path = request.url ?? '';
        providerCalls.push({ method: request.method ?? '', path, body: raw === '' ? undefined : JSON.parse(raw) });
        if (path.startsWith('/accounts/')) {
          answer(response, 200, { id: decodeURIComponent(path.slice('/accounts/'.length)) });
        } else if (path.endsWith('/refunds')) {
          answer(response, 201, { id: `re_${nextRefund++}` });
        } else {
          const n = nextPayment++;
          answer(response, 201, { id: `pay_${n}`, payUrl: `https://pay.example.org/${n}` });
        }
      });
    });
    providerUrl = await listening(providerServer);
    // The receipts store: it keeps every file it is sent, as `file-N`.
    storeServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on('end', () => {
        storeCalls += 1;
        answer(response, 201, { id: `file-${storeCalls}`, url: `https://receipts.example/files/file-${storeCalls}` });
      });
    });
    receiptsUrl = await listening(storeServer);
    app = await startApp();
  });

  afterEach(async () => {
    await app.stop();
    await closed(providerServer);
    await closed(storeServer);
    directory.remove();
  });

  /** What a refused change must leave as it is: every row of the file, and what the provider and the store were asked. */
  function snapshot(): { rows: string; provider: number; store: number } {
    return { rows: dumpOf(directory.databasePath), provider: providerCalls.length, store: storeCalls };
  }

  async function createGroup(token: string, name = 'Flat'): Promise<string> {
    const reply = must(await send(app, 'POST', '/groups', { token, body: { name, currency: 'EUR' } }), 201);
    return (reply.body as { id: string }).id;
  }

  async function invite(token: string, groupId: string): Promise<string> {
    const reply = must(await send(app, 'POST', `/groups/${groupId}/invitations`, { token }), 201);
    return (reply.body as { id: string }).id;
  }

  async function join(ownerToken: string, groupId: string, joinerToken: string): Promise<void> {
    const invitation = await invite(ownerToken, groupId);
    must(await send(app, 'POST', `/invitations/${invitation}/accept`, { token: joinerToken }), 204);
  }

  async function recordExpense(token: string, groupId: string, body: Record<string, unknown>): Promise<string> {
    const reply = must(
      await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token,
        body: { description: 'Dinner', amount: 1000, date: DAY, ...body },
      }),
      201,
    );
    return (reply.body as { id: string }).id;
  }

  /** Attaches a receipt to the expense, as its payer; the file is sent as the body, as the API asks. */
  async function attachReceipt(token: string, expenseId: string): Promise<Reply> {
    const response = await fetch(`${app.address}/${app.apiPrefix}/expenses/${expenseId}/receipt`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
      body: JPEG,
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
  }

  /** Delivers a webhook of the provider, signed, and answers the status it got. */
  async function deliver(event: Record<string, unknown>): Promise<number> {
    const body = JSON.stringify(event);
    const response = await fetch(`${app.address}/${app.apiPrefix}/provider/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'provider-signature': signed(body) },
      body,
    });
    return response.status;
  }

  /** Ana owns a group with Ben, and Ana paid 10.00 split equally: Ben owes 5.00, and pays it in cash. Every balance is 0. */
  async function settledGroup(): Promise<Omit<Fixture, 'recurringId' | 'templateId' | 'invitationId'>> {
    const ana = await signedUpAccount(app, { email: 'ana@example.org', name: 'Ana' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    const dee = await signedUpAccount(app, { email: 'dee@example.org', name: 'Dee' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    const expenseId = await recordExpense(ana.token, groupId, { splitBetween: [ana.id, ben.id] });
    must(
      await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: ana.token,
        body: { from: ben.id, amount: 500 },
      }),
      201,
    );
    return { ana, ben, cy, dee, groupId, expenseId };
  }

  /**
   * The settled group, with what a change could alter in it: a receipt, a budget, a template, a recurring expense and an
   * invitation Cy has not accepted. Archived by Ana.
   */
  async function archivedGroup(): Promise<Fixture> {
    const settled = await settledGroup();
    const { ana, ben, cy, groupId, expenseId } = settled;
    must(await attachReceipt(ana.token, expenseId), 204);
    must(
      await send(app, 'PUT', `/groups/${groupId}/budgets/groceries`, { token: ana.token, body: { amount: 5000 } }),
      204,
    );
    const templateId = (
      must(
        await send(app, 'POST', `/groups/${groupId}/templates`, {
          token: ana.token,
          body: { name: 'Even', splitBetween: [ana.id, ben.id] },
        }),
        201,
      ).body as { id: string }
    ).id;
    const recurringId = (
      must(
        await send(app, 'POST', `/groups/${groupId}/recurring`, {
          token: ana.token,
          body: { description: 'Rent', amount: 800, startsOn: DAY, splitBetween: [ana.id, ben.id] },
        }),
        201,
      ).body as { id: string }
    ).id;
    const invitationId = await invite(ana.token, groupId);
    must(await send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token }), 204);
    return { ...settled, cy, templateId, recurringId, invitationId };
  }

  /**
   * Ana owns a group with Ben, and Ben pays Ana 5.00 through the provider: the payment succeeds, so it is paid. Ana has
   * a payout account. Not archived.
   */
  async function providerSettledGroup(): Promise<{
    ana: Member;
    ben: Member;
    groupId: string;
    settlementId: string;
    paymentId: string;
  }> {
    const ana = await signedUpAccount(app, { email: 'ana@example.org', name: 'Ana' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await recordExpense(ana.token, groupId, { splitBetween: [ana.id, ben.id] });
    must(
      await send(app, 'PUT', '/accounts/me/payout-account', { token: ana.token, body: { accountId: 'acct_ana' } }),
      204,
    );
    const settlementId = (
      must(
        await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
          token: ben.token,
          body: { to: ana.id, amount: 500 },
        }),
        201,
      ).body as { id: string }
    ).id;
    const paymentId = rowOf(
      directory.databasePath,
      'SELECT provider_payment_id FROM settlements WHERE id = ?',
      settlementId,
    ).provider_payment_id as string;
    expect(
      await deliver({ id: `evt_${paymentId}`, paymentId, status: 'succeeded', at: new Date(now).toISOString() }),
    ).toBe(204);
    return { ana, ben, groupId, settlementId, paymentId };
  }

  describe('archiving', () => {
    it('lets the owner archive a group whose balances are 0, answering 204, and reads when it was archived', async () => {
      const { ana, ben, groupId } = await settledGroup();
      const before = must(await send(app, 'GET', `/groups/${groupId}`, { token: ben.token }), 200);
      expect(before.body).not.toHaveProperty('archivedAt');

      const archived = must(await send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token }), 204);
      expect(archived.body).toBeUndefined();

      const group = must(await send(app, 'GET', `/groups/${groupId}`, { token: ben.token }), 200).body as Record<
        string,
        unknown
      >;
      expect(group).toEqual({
        id: groupId,
        name: 'Flat',
        currency: 'EUR',
        ownerId: ana.id,
        archivedAt: expect.any(String),
      });
      expect(group.archivedAt).toMatch(ISO_INSTANT);
      const mine = must(await send(app, 'GET', '/groups/mine', { token: ben.token }), 200).body as {
        id: string;
        archivedAt?: string;
      }[];
      expect(mine).toEqual([expect.objectContaining({ id: groupId, archivedAt: group.archivedAt })]);
    });

    it('refuses a member who is not the owner, as NotOwner, and changes nothing', async () => {
      const { ben, groupId } = await settledGroup();
      const before = snapshot();
      const reply = await send(app, 'POST', `/groups/${groupId}/archive`, { token: ben.token });
      expect(reply.status).toBe(403);
      expect(reply.body).toMatchObject({ statusCode: 403, error: 'NotOwner' });
      expect(snapshot()).toEqual(before);
    });

    it('refuses a request from someone who is no member, as if the group did not exist, and changes nothing', async () => {
      const { dee, groupId } = await settledGroup();
      const before = snapshot();
      const reply = await send(app, 'POST', `/groups/${groupId}/archive`, { token: dee.token });
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ statusCode: 404, error: 'GroupNotFound' });
      expect(snapshot()).toEqual(before);
    });

    it('refuses while a balance is not 0, as BalancesAreNotZero, and changes nothing', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org', name: 'Ana' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const groupId = await createGroup(ana.token);
      await join(ana.token, groupId, ben.token);
      await recordExpense(ana.token, groupId, { splitBetween: [ana.id, ben.id] });
      const before = snapshot();
      const reply = await send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token });
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ statusCode: 409, error: 'BalancesAreNotZero' });
      expect(snapshot()).toEqual(before);
      expect(must(await send(app, 'GET', `/groups/${groupId}`, { token: ana.token }), 200).body).not.toHaveProperty(
        'archivedAt',
      );
    });

    it('refuses while a refund of a settlement through the provider is under way, as SettlementIsInProgress', async () => {
      const { ana, groupId, settlementId } = await providerSettledGroup();
      must(await send(app, 'POST', `/settlements/${settlementId}/refund`, { token: ana.token }), 204);
      const before = snapshot();
      const reply = await send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token });
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ statusCode: 409, error: 'SettlementIsInProgress' });
      expect(snapshot()).toEqual(before);
    });

    it('refuses to archive again, as GroupIsArchived, and keeps the time it was archived', async () => {
      const { ana, ben, groupId } = await settledGroup();
      must(await send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token }), 204);
      const archivedAt = (
        must(await send(app, 'GET', `/groups/${groupId}`, { token: ben.token }), 200).body as {
          archivedAt: string;
        }
      ).archivedAt;
      now += DAY_MS;
      const before = snapshot();
      const reply = await send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token });
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ statusCode: 409, error: 'GroupIsArchived' });
      expect(snapshot()).toEqual(before);
      expect(
        (must(await send(app, 'GET', `/groups/${groupId}`, { token: ben.token }), 200).body as { archivedAt: string })
          .archivedAt,
      ).toBe(archivedAt);
    });

    it('reads a group of a file written before archiving as not archived, and archives it', async () => {
      const { ana, ben, groupId } = await settledGroup();
      await app.stop();
      const db = new DatabaseSync(directory.databasePath);
      db.exec('ALTER TABLE groups DROP COLUMN archived_at');
      db.close();
      app = await startApp();

      expect(must(await send(app, 'GET', `/groups/${groupId}`, { token: ben.token }), 200).body).not.toHaveProperty(
        'archivedAt',
      );
      must(await send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token }), 204);
      expect(must(await send(app, 'GET', `/groups/${groupId}`, { token: ben.token }), 200).body).toMatchObject({
        archivedAt: expect.any(String),
      });
    });
  });

  describe('once archived', () => {
    /** Each request that would change the archived group, by what it does; each is refused as GroupIsArchived. */
    const CHANGES: Record<string, (fixture: Fixture) => Promise<Reply>> = {
      'recording an expense': ({ ana, ben, groupId }) =>
        send(app, 'POST', `/groups/${groupId}/expenses`, {
          token: ana.token,
          body: { description: 'Taxi', amount: 500, date: DAY, splitBetween: [ana.id, ben.id] },
        }),
      'editing an expense': ({ ana, ben, expenseId }) =>
        send(app, 'PUT', `/expenses/${expenseId}`, {
          token: ana.token,
          body: { description: 'Dinner', amount: 1200, date: DAY, splitBetween: [ana.id, ben.id], version: 1 },
        }),
      'deleting an expense': ({ ana, expenseId }) =>
        send(app, 'DELETE', `/expenses/${expenseId}`, { token: ana.token }),
      'attaching a receipt': ({ ana, expenseId }) => attachReceipt(ana.token, expenseId),
      'asking for a settlement in cash': ({ ana, ben, groupId }) =>
        send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
          token: ana.token,
          body: { from: ben.id, amount: 100 },
        }),
      'asking for a settlement through the provider': ({ ben, ana, groupId }) =>
        send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
          token: ben.token,
          body: { to: ana.id, amount: 100 },
        }),
      'creating an invitation': ({ ana, groupId }) =>
        send(app, 'POST', `/groups/${groupId}/invitations`, { token: ana.token }),
      joining: ({ cy, invitationId }) => send(app, 'POST', `/invitations/${invitationId}/accept`, { token: cy.token }),
      leaving: ({ ben, groupId }) => send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token }),
      'setting up a recurring expense': ({ ana, ben, groupId }) =>
        send(app, 'POST', `/groups/${groupId}/recurring`, {
          token: ana.token,
          body: { description: 'Gym', amount: 300, startsOn: DAY, splitBetween: [ana.id, ben.id] },
        }),
      'stopping a recurring expense': ({ ana, recurringId }) =>
        send(app, 'DELETE', `/recurring/${recurringId}`, { token: ana.token }),
      'setting a budget': ({ ana, groupId }) =>
        send(app, 'PUT', `/groups/${groupId}/budgets/food`, { token: ana.token, body: { amount: 9000 } }),
      'removing a budget': ({ ana, groupId }) =>
        send(app, 'DELETE', `/groups/${groupId}/budgets/groceries`, { token: ana.token }),
      'saving a template': ({ ana, ben, groupId }) =>
        send(app, 'POST', `/groups/${groupId}/templates`, {
          token: ana.token,
          body: { name: 'Odd', splitBetween: [ana.id, ben.id] },
        }),
      'replacing a template': ({ ana, ben, templateId }) =>
        send(app, 'PUT', `/templates/${templateId}`, {
          token: ana.token,
          body: { name: 'Halves', splitBetween: [ana.id, ben.id] },
        }),
      'removing a template': ({ ana, templateId }) =>
        send(app, 'DELETE', `/templates/${templateId}`, { token: ana.token }),
      'archiving it again': ({ ana, groupId }) => send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token }),
    };

    it.each(Object.keys(CHANGES))('refuses %s as GroupIsArchived, and changes nothing', async action => {
      const fixture = await archivedGroup();
      const before = snapshot();
      const reply = await CHANGES[action](fixture);
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({
        statusCode: 409,
        error: 'GroupIsArchived',
        message: 'The group is archived: nothing in it changes.',
      });
      expect(snapshot()).toEqual(before);
    });

    it('refuses a refund of a settlement through the provider, and asks the provider nothing', async () => {
      const { ana, groupId, settlementId } = await providerSettledGroup();
      must(await send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token }), 204);
      const before = snapshot();
      const reply = await send(app, 'POST', `/settlements/${settlementId}/refund`, { token: ana.token });
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ statusCode: 409, error: 'GroupIsArchived' });
      expect(snapshot()).toEqual(before);
      expect(
        must(await send(app, 'GET', `/settlements/${settlementId}`, { token: ana.token }), 200).body,
      ).toMatchObject({
        status: 'paid',
      });
    });

    it('keeps a settlement of an archived group as it is when the provider says it was refunded', async () => {
      const { ana, groupId, settlementId, paymentId } = await providerSettledGroup();
      must(await send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token }), 204);
      const before = snapshot();
      expect(
        await deliver({ id: `evt_refunded_${paymentId}`, paymentId, status: 'refunded', at: '2026-11-11T09:00:00Z' }),
      ).toBe(204);
      expect(snapshot()).toEqual(before);
      expect(
        must(await send(app, 'GET', `/settlements/${settlementId}`, { token: ana.token }), 200).body,
      ).toMatchObject({
        status: 'paid',
      });
    });

    it('lets its members read it as before: the group, members, balances, expenses, receipts, statements, settlements, budgets, templates and recurring expenses', async () => {
      const fixture = await archivedGroup();
      const { ana, ben, dee, groupId, expenseId, recurringId, templateId } = fixture;
      const read = (path: string, token = ben.token) => send(app, 'GET', path, { token });

      expect(must(await read(`/groups/${groupId}`), 200).body).toEqual({
        id: groupId,
        name: 'Flat',
        currency: 'EUR',
        ownerId: ana.id,
        archivedAt: expect.any(String),
      });
      expect(must(await read('/groups/mine'), 200).body).toEqual([expect.objectContaining({ id: groupId })]);
      expect(must(await read(`/groups/${groupId}/members`), 200).body).toEqual([
        expect.objectContaining({ memberId: ana.id, role: 'owner' }),
        expect.objectContaining({ memberId: ben.id, role: 'member' }),
      ]);
      expect(must(await read(`/groups/${groupId}/balances`), 200).body).toEqual([
        { memberId: ana.id, balance: 0 },
        { memberId: ben.id, balance: 0 },
      ]);
      expect(must(await read(`/groups/${groupId}/expenses`), 200).body).toEqual([
        expect.objectContaining({ id: expenseId, amount: 1000 }),
      ]);
      expect(must(await read(`/expenses/${expenseId}`), 200).body).toEqual(expect.objectContaining({ id: expenseId }));
      expect(must(await read(`/expenses/${expenseId}/receipt`), 200).body).toEqual({
        type: 'image/jpeg',
        size: JPEG.length,
        url: 'https://receipts.example/files/file-1',
      });
      // Ben's statement lists the 5.00 he owed for the dinner and the settlement that paid it, so its balance is 0.
      expect(must(await read(`/groups/${groupId}/members/${ben.id}/statement`), 200).body).toMatchObject({
        memberId: ben.id,
        balance: 0,
        entries: [
          expect.objectContaining({ kind: 'expense', expenseId, share: 500, paid: 0 }),
          expect.objectContaining({ kind: 'settlement', paid: 500, share: 0 }),
        ],
      });
      const settlements = must(await read(`/groups/${groupId}/settlements`), 200).body as { id: string }[];
      expect(settlements).toHaveLength(1);
      expect(must(await read(`/settlements/${settlements[0].id}`), 200).body).toMatchObject({ status: 'paid' });
      expect(must(await read(`/groups/${groupId}/settlements/suggested`), 200).body).toEqual([]);
      expect(must(await read(`/groups/${groupId}/budgets`), 200).body).toEqual([
        expect.objectContaining({ category: 'groceries', amount: 5000 }),
      ]);
      expect(must(await read(`/groups/${groupId}/templates`), 200).body).toEqual([
        expect.objectContaining({ id: templateId, name: 'Even' }),
      ]);
      expect(must(await read(`/groups/${groupId}/recurring`), 200).body).toEqual([
        expect.objectContaining({ id: recurringId, description: 'Rent' }),
      ]);
      expect(must(await read(`/recurring/${recurringId}`), 200).body).toEqual(
        expect.objectContaining({ id: recurringId }),
      );
      // Someone who is no member reads nothing of it, as before.
      expect((await read(`/groups/${groupId}`, dee.token)).status).toBe(404);
    });

    it('records no expense of a recurring expense of an archived group, and leaves that recurring expense as it is', async () => {
      const fixture = await archivedGroup();
      const { ana, ben, groupId, recurringId } = fixture;
      // A group of the same two members, not archived, whose recurring expense falls due too.
      const flat = await createGroup(ana.token, 'Other flat');
      await join(ana.token, flat, ben.token);
      must(
        await send(app, 'POST', `/groups/${flat}/recurring`, {
          token: ana.token,
          body: { description: 'Rent', amount: 800, startsOn: DAY, splitBetween: [ana.id, ben.id] },
        }),
        201,
      );

      now = Date.parse('2026-11-12T09:00:00.000Z');
      app.runJobs();

      const expensesOf = async (id: string) =>
        (must(await send(app, 'GET', `/groups/${id}/expenses`, { token: ana.token }), 200).body as unknown[]).length;
      expect(await expensesOf(flat)).toBe(1);
      expect(await expensesOf(groupId)).toBe(1);
      expect(must(await send(app, 'GET', `/recurring/${recurringId}`, { token: ana.token }), 200).body).toMatchObject({
        next: DAY,
      });
    });

    it('does not forget a member who owed for a while, in an archived group, at the sweep of the reminders', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org', name: 'Ana' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const groupId = await createGroup(ana.token);
      await join(ana.token, groupId, ben.token);
      // Ben owes 30.00 from the start: noticed at the first sweep, reminded a week on.
      await recordExpense(ana.token, groupId, { amount: 6000, splitBetween: [ana.id, ben.id] });
      app.runJobs();
      now += 8 * DAY_MS;
      app.runJobs();
      must(
        await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
          token: ana.token,
          body: { from: ben.id, amount: 3000 },
        }),
        201,
      );
      must(await send(app, 'POST', `/groups/${groupId}/archive`, { token: ana.token }), 204);

      now += 8 * DAY_MS;
      app.runJobs();
      expect(
        rowOf(directory.databasePath, 'SELECT COUNT(*) AS n FROM lasting_debts WHERE group_id = ?', groupId),
      ).toEqual({
        n: 1,
      });
    });
  });
});
