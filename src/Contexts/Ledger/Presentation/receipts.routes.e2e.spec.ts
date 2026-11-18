import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Receipts (request 26, the API's fragment 26), over HTTP against a database file and a fake receipts store on a local port: the payer or
 * the owner attaches a JPEG or a PNG, a member reads its type, size and link, the file is refused by its bytes or its size with nothing sent,
 * and a store that keeps nothing (down, slow, answering junk, or not configured) refuses the receipt with nothing changed.
 */
let directory: string;
let store: Server;
let storeUrl: string;
/** How the fake store answers: keeps the file, is down, answers junk, or does not answer at all. */
let storeMode: 'ok' | 'down' | 'junk' | 'hang';
/** The files the store was sent: their content type and size. */
let received: { contentType: string; size: number }[];

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const day = '2026-01-15';
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const TWO_MB = 2_097_152;

let app: FastifyApplication;
let appWithoutStore: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let httpWithoutStore: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-receipts-'));
  received = [];
  store = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/files') {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const bytes = Buffer.concat(chunks);
      received.push({ contentType: String(req.headers['content-type']), size: bytes.length });
      if (storeMode === 'hang') return;
      if (storeMode === 'down') {
        res.statusCode = 503;
        res.end('unavailable');
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (storeMode === 'junk') {
        res.statusCode = 201;
        res.end(JSON.stringify({ id: '' }));
        return;
      }
      res.statusCode = 201;
      res.end(JSON.stringify({ id: `file-${received.length}`, url: `${storeUrl}/read/file-${received.length}` }));
    });
  });
  await new Promise<void>(resolve => store.listen(0, '127.0.0.1', resolve));
  storeUrl = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
  storeMode = 'ok';

  app = await createApplication({
    databasePath: join(directory, 'with.sqlite'),
    logger: silent,
    receiptsUrl: storeUrl,
    jobsIntervalSeconds: 3600,
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;

  appWithoutStore = await createApplication({
    databasePath: join(directory, 'without.sqlite'),
    logger: silent,
    jobsIntervalSeconds: 3600,
  });
  await appWithoutStore.start(0);
  httpWithoutStore = apiClient(appWithoutStore.address);
});

afterAll(async () => {
  await app.stop();
  await appWithoutStore.stop();
  store.closeAllConnections();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

interface Person {
  token: string;
  id: string;
}

async function person(client: ReturnType<typeof apiClient>, name: string, email: string): Promise<Person> {
  await client.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await client.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await client.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group of `owner`, with `others` joined. */
async function groupOf(client: ReturnType<typeof apiClient>, owner: Person, others: Person[]): Promise<string> {
  const { body } = await client.request('POST', `${api}/groups`, {
    token: owner.token,
    body: { name: 'Receipts', currency: 'EUR' },
  });
  const groupId = (body as { id: string }).id;
  for (const who of others) {
    const invitation = await client.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await client.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: who.token,
    });
  }
  return groupId;
}

/** An expense of 60.00 EUR paid by `payer`, split equally between the two of the group, and its id. */
async function expenseOf(client: ReturnType<typeof apiClient>, payer: Person, groupId: string, others: Person[]) {
  const { status, body } = await client.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: payer.token,
    body: { description: 'Groceries', amount: 6000, date: day, splitBetween: [payer.id, ...others.map(o => o.id)] },
  });
  expect(status).toBe(201);
  return (body as { id: string }).id;
}

const attach = (client: ReturnType<typeof apiClient>, who: Person, expenseId: string, bytes: Uint8Array) =>
  client.request('PUT', `${api}/expenses/${expenseId}/receipt`, {
    token: who.token,
    raw: { bytes, contentType: 'application/octet-stream' },
  });

describe('a payer or the owner attaches a receipt, and a member reads it', () => {
  it('attaches a JPEG as the payer, reads its type, size and link, replaces it with a PNG, and keeps the expense’s version', async () => {
    const ann = await person(http, 'Ann', 'ann@receipts.example.com');
    const bob = await person(http, 'Bob', 'bob@receipts.example.com');
    const groupId = await groupOf(http, ann, [bob]);
    const expenseId = await expenseOf(http, ann, groupId, [bob]);

    expect(await attach(http, ann, expenseId, JPEG)).toMatchObject({ status: 204 });
    const read = await http.request('GET', `${api}/expenses/${expenseId}/receipt`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ type: 'image/jpeg', size: JPEG.length, url: expect.stringContaining('/read/file-') });

    expect(await attach(http, ann, expenseId, PNG)).toMatchObject({ status: 204 });
    const replaced = await http.request('GET', `${api}/expenses/${expenseId}/receipt`, { token: ann.token });
    expect(replaced.body).toEqual({ type: 'image/png', size: PNG.length, url: expect.stringContaining('/read/file-') });
    expect((replaced.body as { url: string }).url).not.toBe((read.body as { url: string }).url);

    const expense = await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token });
    expect((expense.body as { version: number }).version).toBe(1);
  });

  it('lets the group’s owner attach to a member’s expense, and refuses another member with 403 and a non-member with 404', async () => {
    const ann = await person(http, 'Owner', 'owner@receipts.example.com');
    const bob = await person(http, 'Payer', 'payer@receipts.example.com');
    const cy = await person(http, 'Other', 'other@receipts.example.com');
    const dee = await person(http, 'Outsider', 'outsider@receipts.example.com');
    const groupId = await groupOf(http, ann, [bob, cy]);
    const expenseId = await expenseOf(http, bob, groupId, [ann, cy]);

    expect(await attach(http, ann, expenseId, JPEG)).toMatchObject({ status: 204 });
    expect(await attach(http, cy, expenseId, JPEG)).toMatchObject({
      status: 403,
      body: { type: 'NotAllowed' },
    });
    expect(await attach(http, dee, expenseId, JPEG)).toMatchObject({ status: 404 });
  });

  it('answers 404 to a read of an expense with no receipt, and to a read by someone outside the group', async () => {
    const ann = await person(http, 'Reader', 'reader@receipts.example.com');
    const outsider = await person(http, 'Stranger', 'stranger@receipts.example.com');
    const groupId = await groupOf(http, ann, []);
    const expenseId = await expenseOf(http, ann, groupId, []);

    expect(await http.request('GET', `${api}/expenses/${expenseId}/receipt`, { token: ann.token })).toMatchObject({
      status: 404,
    });
    expect(await http.request('GET', `${api}/expenses/${expenseId}/receipt`, { token: outsider.token })).toMatchObject({
      status: 404,
    });
  });

  it('answers 401 to an attach with no caller, before anything is sent to the store', async () => {
    const ann = await person(http, 'Anon', 'anon@receipts.example.com');
    const groupId = await groupOf(http, ann, []);
    const expenseId = await expenseOf(http, ann, groupId, []);
    const sent = received.length;

    const answer = await http.request('PUT', `${api}/expenses/${expenseId}/receipt`, {
      raw: { bytes: JPEG, contentType: 'application/octet-stream' },
    });
    expect(answer.status).toBe(401);
    expect(received.length).toBe(sent);
  });
});

describe('a file that is not a JPEG or a PNG of 1 byte to 2 MB is refused, and nothing is sent to the store', () => {
  it('refuses a GIF, an empty file and one over 2 MB with 422, and sends none of them', async () => {
    const ann = await person(http, 'Sizer', 'sizer@receipts.example.com');
    const groupId = await groupOf(http, ann, []);
    const expenseId = await expenseOf(http, ann, groupId, []);
    const sent = received.length;

    expect(await attach(http, ann, expenseId, GIF)).toMatchObject({
      status: 422,
      body: { type: 'UnsupportedReceiptType' },
    });
    expect(await attach(http, ann, expenseId, new Uint8Array(0))).toMatchObject({
      status: 422,
      body: { type: 'InvalidReceiptSize' },
    });
    const tooLarge = new Uint8Array(TWO_MB + 1);
    tooLarge.set(JPEG);
    expect(await attach(http, ann, expenseId, tooLarge)).toMatchObject({
      status: 422,
      body: { type: 'InvalidReceiptSize' },
    });
    expect(received.length).toBe(sent);
  });

  it('accepts a JPEG of exactly 2 MB', async () => {
    const ann = await person(http, 'Exact', 'exact@receipts.example.com');
    const groupId = await groupOf(http, ann, []);
    const expenseId = await expenseOf(http, ann, groupId, []);
    const exact = new Uint8Array(TWO_MB);
    exact.set(JPEG);

    expect(await attach(http, ann, expenseId, exact)).toMatchObject({ status: 204 });
    const read = await http.request('GET', `${api}/expenses/${expenseId}/receipt`, { token: ann.token });
    expect(read.body).toMatchObject({ type: 'image/jpeg', size: TWO_MB });
  });
});

describe('a store that keeps nothing refuses the receipt, and nothing changes', () => {
  it('refuses with 422 ReceiptNotKept when the store is down or answers junk, and keeps the expense’s receipt as it was', async () => {
    const ann = await person(http, 'Flaky', 'flaky@receipts.example.com');
    const groupId = await groupOf(http, ann, []);
    const expenseId = await expenseOf(http, ann, groupId, []);
    expect(await attach(http, ann, expenseId, JPEG)).toMatchObject({ status: 204 });
    const before = await http.request('GET', `${api}/expenses/${expenseId}/receipt`, { token: ann.token });

    storeMode = 'down';
    expect(await attach(http, ann, expenseId, PNG)).toMatchObject({ status: 422, body: { type: 'ReceiptNotKept' } });
    storeMode = 'junk';
    expect(await attach(http, ann, expenseId, PNG)).toMatchObject({ status: 422, body: { type: 'ReceiptNotKept' } });
    storeMode = 'ok';

    const after = await http.request('GET', `${api}/expenses/${expenseId}/receipt`, { token: ann.token });
    expect(after.body).toEqual(before.body);
  });

  it('refuses with 422 when the store does not answer within 5 seconds', async () => {
    const ann = await person(http, 'Slow', 'slow@receipts.example.com');
    const groupId = await groupOf(http, ann, []);
    const expenseId = await expenseOf(http, ann, groupId, []);

    storeMode = 'hang';
    try {
      expect(await attach(http, ann, expenseId, JPEG)).toMatchObject({
        status: 422,
        body: { type: 'ReceiptNotKept' },
      });
    } finally {
      storeMode = 'ok';
    }
  }, 20_000);

  it('refuses every receipt with 422 when no receipts store is configured', async () => {
    const ann = await person(httpWithoutStore, 'Nostore', 'nostore@receipts.example.com');
    const groupId = await groupOf(httpWithoutStore, ann, []);
    const expenseId = await expenseOf(httpWithoutStore, ann, groupId, []);

    expect(await attach(httpWithoutStore, ann, expenseId, JPEG)).toMatchObject({
      status: 422,
      body: { type: 'ReceiptNotKept' },
    });
  });
});

describe('Groups → Ledger', () => {
  it('a member who has just joined a group in Groups pays in Ledger, attaches a receipt, and finds the expense by the id Ledger answered', async () => {
    const ann = await person(http, 'Creator', 'creator@receipts.example.com');
    const bob = await person(http, 'Newcomer', 'newcomer@receipts.example.com');
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Joined', currency: 'EUR' },
    });
    const groupId = (created.body as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });

    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: bob.token,
      body: { description: 'Taxi', amount: 1800, date: day, splitBetween: [ann.id, bob.id] },
    });
    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;
    expect(await attach(http, bob, expenseId, JPEG)).toMatchObject({ status: 204 });

    const listed = await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: ann.token });
    expect((listed.body as { id: string }[]).map(expense => expense.id)).toContain(expenseId);
    const read = await http.request('GET', `${api}/expenses/${expenseId}/receipt`, { token: ann.token });
    expect(read.body).toMatchObject({ type: 'image/jpeg', size: JPEG.length });
  });
});
