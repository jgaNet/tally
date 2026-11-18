import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { createApplication, type Application } from './app';
import { openDatabase } from './database';
import { MAX_RECEIPT_BYTES } from './receipts';
import { send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
/** A JPEG: its start, then the rest of a file. */
const JPEG = Buffer.concat([JPEG_START, Buffer.from([0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A PNG: its signature, then the rest of a file. */
const PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from('IHDR and the rest of the file')]);

/** A request the fake receipts store was sent. */
interface StoreCall {
  method: string;
  path: string;
  contentType: string | undefined;
  body: Buffer;
}

/** The answer a fake receipts store gives to one request. */
interface StoreAnswer {
  status: number;
  body?: unknown;
  /** Sent as the body instead of `body`, as it is. */
  text?: string;
  /** Waits this long before answering. */
  delayMs?: number;
}

/** Sends `bytes` as the body of a request to the application's API, with `contentType` as its type. */
async function sendBytes(
  app: Application,
  method: 'PUT' | 'GET' | 'DELETE',
  path: string,
  options: { bytes?: Buffer; contentType?: string; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (options.contentType !== undefined) headers['content-type'] = options.contentType;
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${app.address}/${app.apiPrefix}${path}`, {
    method,
    headers,
    body: options.bytes === undefined ? undefined : new Uint8Array(options.bytes),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

describe('receipts', () => {
  let directory: TestDirectory;
  let app: Application;
  let service: Server;
  let serviceUrl: string;
  /** The requests the fake receipts store was sent, in order. */
  let calls: StoreCall[];
  let answerWith: (call: StoreCall) => StoreAnswer;

  /** The store's answer when it keeps the file: the id and link of the `n`th file it keeps. */
  const keptAs = (n: number): StoreAnswer => ({
    status: 201,
    body: { id: `file-${n}`, url: `https://receipts.example/files/file-${n}` },
  });

  beforeEach(async () => {
    directory = testDirectory();
    calls = [];
    answerWith = () => keptAs(calls.length);
    service = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const call: StoreCall = {
          method: request.method ?? '',
          path: request.url ?? '',
          contentType: request.headers['content-type'],
          body: Buffer.concat(chunks),
        };
        calls.push(call);
        const answer = answerWith(call);
        const respond = () => {
          try {
            response.writeHead(answer.status, { 'content-type': 'application/json' });
            response.end(answer.text ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)));
          } catch {
            // The caller gave up on the answer already.
          }
        };
        if (answer.delayMs) setTimeout(respond, answer.delayMs);
        else respond();
      });
    });
    await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
    serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    app = await createApplication({
      databasePath: directory.databasePath,
      receiptsUrl: serviceUrl,
      receiptsTimeoutMs: 200,
    });
    await app.start(0);
  });

  afterEach(async () => {
    await app.stop();
    await new Promise<void>(resolve => service.close(() => resolve()));
    service.closeAllConnections();
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

  /** Records an expense of 1000 in `groupId` as `token`'s account, split between `ids`; answers its id. */
  async function recordOk(token: string, groupId: string, ids: string[], amount = 1000): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description: 'Groceries', amount, date: utcDay(0), splitBetween: ids },
    });
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Attaches `bytes` to the expense as `token`'s account, sent as the file itself unless `contentType` says otherwise. */
  async function attach(token: string | undefined, expenseId: string, bytes?: Buffer, contentType?: string) {
    return sendBytes(app, 'PUT', `/expenses/${expenseId}/receipt`, {
      token,
      bytes,
      contentType: contentType ?? 'application/octet-stream',
    });
  }

  async function readReceipt(token: string, expenseId: string) {
    return send(app, 'GET', `/expenses/${expenseId}/receipt`, { token });
  }

  async function versionOf(token: string, expenseId: string): Promise<number> {
    const reply = await send(app, 'GET', `/expenses/${expenseId}`, { token });
    return (reply.body as { version: number }).version;
  }

  /** A group of `ana` (the owner) and `ben`, and an expense of 1000 that `ana` paid, split between them. */
  async function setUp() {
    const ana = await signedUpAccount(app, { email: 'ana@example.org', name: 'Ana' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const cleo = await signedUpAccount(app, { email: 'cleo@example.org', name: 'Cleo' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    const expenseId = await recordOk(ana.token, groupId, [ana.id, ben.id]);
    return { ana, ben, cleo, groupId, expenseId };
  }

  describe('attaching a receipt', () => {
    it('keeps a JPEG at the store, sent as the file itself and typed as a JPEG, and answers 204', async () => {
      const { ana, expenseId } = await setUp();
      const reply = await attach(ana.token, expenseId, JPEG);
      expect(reply.status).toBe(204);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('POST');
      expect(calls[0].path).toBe('/files');
      expect(calls[0].contentType).toBe('image/jpeg');
      expect(calls[0].body.equals(JPEG)).toBe(true);
    });

    it('keeps a PNG at the store, typed as a PNG', async () => {
      const { ana, expenseId } = await setUp();
      expect((await attach(ana.token, expenseId, PNG)).status).toBe(204);
      expect(calls).toHaveLength(1);
      expect(calls[0].contentType).toBe('image/png');
      expect(calls[0].body.equals(PNG)).toBe(true);
    });

    it('takes the type from the first bytes of the file, whatever follows them', async () => {
      const { ana, expenseId } = await setUp();
      expect((await attach(ana.token, expenseId, JPEG_START)).status).toBe(204);
      expect(calls[0].contentType).toBe('image/jpeg');
    });

    it('accepts a file of exactly 2 097 152 bytes, the largest', async () => {
      const { ana, expenseId } = await setUp();
      const largest = Buffer.concat([JPEG, Buffer.alloc(MAX_RECEIPT_BYTES - JPEG.length)]);
      expect(largest.length).toBe(2_097_152);
      expect((await attach(ana.token, expenseId, largest)).status).toBe(204);
      expect(calls[0].body.length).toBe(2_097_152);
      const read = await readReceipt(ana.token, expenseId);
      expect(read.body).toEqual({ type: 'image/jpeg', size: 2_097_152, url: 'https://receipts.example/files/file-1' });
    });

    it('refuses a file one byte larger than 2 097 152 bytes, with 4xx, and sends nothing to the store', async () => {
      const { ana, expenseId } = await setUp();
      const tooLarge = Buffer.concat([JPEG, Buffer.alloc(MAX_RECEIPT_BYTES - JPEG.length + 1)]);
      const reply = await attach(ana.token, expenseId, tooLarge);
      expect(reply.status).toBe(413);
      expect(calls).toHaveLength(0);
      expect((await readReceipt(ana.token, expenseId)).status).toBe(404);
    });

    it('refuses an empty file, and a request with no file, with 422, and sends nothing to the store', async () => {
      const { ana, expenseId } = await setUp();
      const empty = await attach(ana.token, expenseId, Buffer.alloc(0));
      expect(empty.status).toBe(422);
      expect(empty.body).toMatchObject({ error: 'ReceiptIsEmpty' });
      const none = await attach(ana.token, expenseId);
      expect(none.status).toBe(422);
      expect(calls).toHaveLength(0);
    });

    it('refuses a file that is neither a JPEG nor a PNG by its first bytes, with 422, and sends nothing to the store', async () => {
      const { ana, expenseId } = await setUp();
      const notReceipts: Buffer[] = [
        Buffer.from('%PDF-1.7 a document'),
        Buffer.from('GIF89a'),
        Buffer.from([0x00, 0xff, 0xd8, 0xff]),
        Buffer.from([0xff, 0xd8, 0xfe, 0x00]),
        Buffer.from([0xff, 0xd8]),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]),
      ];
      for (const bytes of notReceipts) {
        const reply = await attach(ana.token, expenseId, bytes);
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'ReceiptIsNotJpegOrPng' });
      }
      expect(calls).toHaveLength(0);
    });

    it('refuses a body that is not sent as application/octet-stream, with 4xx, and sends nothing to the store', async () => {
      const { ana, expenseId } = await setUp();
      expect((await attach(ana.token, expenseId, JPEG, 'image/jpeg')).status).toBe(415);
      const asJson = await sendBytes(app, 'PUT', `/expenses/${expenseId}/receipt`, {
        token: ana.token,
        bytes: Buffer.from('{}'),
        contentType: 'application/json',
      });
      expect(asJson.status).toBe(415);
      expect(calls).toHaveLength(0);
    });

    it('refuses a request with no token, or an unproven one, with 401, and sends nothing to the store', async () => {
      const { expenseId } = await setUp();
      expect((await attach(undefined, expenseId, JPEG)).status).toBe(401);
      expect((await attach('not-a-real-token', expenseId, JPEG)).status).toBe(401);
      expect(calls).toHaveLength(0);
    });

    it('answers 404 for an expense that does not exist, and sends nothing to the store', async () => {
      const { ana } = await setUp();
      const reply = await attach(ana.token, 'no-such-expense', JPEG);
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ error: 'ExpenseNotFound' });
      expect(calls).toHaveLength(0);
    });

    it('answers 404 to a signed-in account outside the group, as if the expense did not exist, and sends nothing to the store', async () => {
      const { cleo, expenseId } = await setUp();
      expect((await attach(cleo.token, expenseId, JPEG)).status).toBe(404);
      expect(calls).toHaveLength(0);
    });

    it('lets the owner attach a receipt to an expense another member paid', async () => {
      const { ana, ben, groupId } = await setUp();
      const benPaid = await recordOk(ben.token, groupId, [ana.id, ben.id]);
      expect((await attach(ana.token, benPaid, JPEG)).status).toBe(204);
      expect((await readReceipt(ben.token, benPaid)).body).toMatchObject({ type: 'image/jpeg' });
    });

    it('refuses an attachment by a member who is neither the payer nor the owner, with 403, and keeps the receipt it had', async () => {
      const { ana, ben, expenseId } = await setUp();
      expect((await attach(ana.token, expenseId, JPEG)).status).toBe(204);
      const reply = await attach(ben.token, expenseId, PNG);
      expect(reply.status).toBe(403);
      expect(reply.body).toMatchObject({ error: 'NotPayerOrOwner' });
      expect(calls).toHaveLength(1);
      expect(await readReceipt(ana.token, expenseId)).toMatchObject({
        status: 200,
        body: { type: 'image/jpeg', size: JPEG.length },
      });
    });

    it('refuses a receipt for an expense of a member who has left the group, with 409, and sends nothing to the store', async () => {
      const { ana } = await setUp();
      const dan = await signedUpAccount(app, { email: 'dan@example.org', name: 'Dan' });
      const otherGroup = await createGroup(ana.token);
      await join(ana.token, otherGroup, dan.token);
      // Dan paid for himself alone, so his balance is 0 and he may leave; the expense then concerns a leaver.
      const danExpense = await recordOk(dan.token, otherGroup, [dan.id], 500);
      const left = await send(app, 'POST', `/groups/${otherGroup}/leave`, { token: dan.token });
      expect(left.status).toBe(204);
      expect((await attach(ana.token, danExpense, JPEG)).status).toBe(409);
      expect(calls).toHaveLength(0);
    });
  });

  describe('reading a receipt', () => {
    it('answers the receipt to the payer: its type, its size in bytes, and the link the store gave the file', async () => {
      const { ana, expenseId } = await setUp();
      await attach(ana.token, expenseId, PNG);
      const reply = await readReceipt(ana.token, expenseId);
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ type: 'image/png', size: PNG.length, url: 'https://receipts.example/files/file-1' });
    });

    it('answers the same receipt to another member of the group, who is not its payer', async () => {
      const { ana, ben, expenseId } = await setUp();
      await attach(ana.token, expenseId, JPEG);
      expect((await readReceipt(ben.token, expenseId)).body).toEqual({
        type: 'image/jpeg',
        size: JPEG.length,
        url: 'https://receipts.example/files/file-1',
      });
    });

    it('answers 404 to an expense with no receipt', async () => {
      const { ana, expenseId } = await setUp();
      const reply = await readReceipt(ana.token, expenseId);
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ error: 'ReceiptNotFound' });
    });

    it('answers 404 to a signed-in account outside the group, as if the expense did not exist', async () => {
      const { ana, cleo, expenseId } = await setUp();
      await attach(ana.token, expenseId, JPEG);
      const reply = await readReceipt(cleo.token, expenseId);
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ error: 'ExpenseNotFound' });
    });

    it('refuses a read with no token, or an unproven one, with 401', async () => {
      const { ana, expenseId } = await setUp();
      await attach(ana.token, expenseId, JPEG);
      expect((await sendBytes(app, 'GET', `/expenses/${expenseId}/receipt`)).status).toBe(401);
      expect((await readReceipt('not-a-real-token', expenseId)).status).toBe(401);
    });

    it('changes nothing however often it is read: no file is asked of the store, and the expense keeps its version', async () => {
      const { ana, expenseId } = await setUp();
      await attach(ana.token, expenseId, JPEG);
      const asked = calls.length;
      for (let read = 0; read < 3; read++) {
        expect((await readReceipt(ana.token, expenseId)).status).toBe(200);
      }
      expect(calls).toHaveLength(asked);
      expect(await versionOf(ana.token, expenseId)).toBe(1);
    });
  });

  describe('replacing and editing', () => {
    it('replaces the receipt the expense had, and the store keeps both files: the latest is the one read', async () => {
      const { ana, expenseId } = await setUp();
      expect((await attach(ana.token, expenseId, JPEG)).status).toBe(204);
      expect((await attach(ana.token, expenseId, PNG)).status).toBe(204);
      expect(calls).toHaveLength(2);
      expect((await readReceipt(ana.token, expenseId)).body).toEqual({
        type: 'image/png',
        size: PNG.length,
        url: 'https://receipts.example/files/file-2',
      });
    });

    it('is not an edit: the expense keeps its version, and an edit made from that version still goes through', async () => {
      const { ana, expenseId } = await setUp();
      await attach(ana.token, expenseId, JPEG);
      expect(await versionOf(ana.token, expenseId)).toBe(1);
      const edit = await send(app, 'PUT', `/expenses/${expenseId}`, {
        token: ana.token,
        body: { description: 'Groceries', amount: 1000, date: utcDay(0), splitBetween: [ana.id], version: 1 },
      });
      expect(edit.status).toBe(200);
      expect((edit.body as { version: number }).version).toBe(2);
    });
  });

  describe('when the store does not keep the file', () => {
    const notKept: [string, StoreAnswer][] = [
      ['answers 500', { status: 500, body: { id: 'file-1', url: 'https://receipts.example/files/file-1' } }],
      [
        'answers 200 rather than 201',
        { status: 200, body: { id: 'file-1', url: 'https://receipts.example/files/file-1' } },
      ],
      ['answers 404', { status: 404, body: { error: 'no' } }],
      ['answers text that is not JSON', { status: 201, text: 'stored' }],
      ['answers nothing but an empty body', { status: 201, text: '' }],
      ['answers an id but no link', { status: 201, body: { id: 'file-1' } }],
      ['answers a link but no id', { status: 201, body: { url: 'https://receipts.example/files/file-1' } }],
      ['answers an empty id', { status: 201, body: { id: '', url: 'https://receipts.example/files/file-1' } }],
      [
        'answers an id that is not text',
        { status: 201, body: { id: 7, url: 'https://receipts.example/files/file-1' } },
      ],
      [
        'answers in more time than it has',
        { status: 201, body: { id: 'file-1', url: 'https://receipts.example/files/file-1' }, delayMs: 1000 },
      ],
    ];

    it.each(notKept)('refuses the receipt with 424 when the store %s, and keeps nothing', async (_, answer) => {
      const { ana, expenseId } = await setUp();
      answerWith = () => answer;
      const reply = await attach(ana.token, expenseId, JPEG);
      expect(reply.status).toBe(424);
      expect(reply.body).toMatchObject({ error: 'ReceiptsUnavailable' });
      expect(calls).toHaveLength(1);
      expect((await readReceipt(ana.token, expenseId)).status).toBe(404);
    });

    it('keeps the receipt the expense had when the store does not keep the new one', async () => {
      const { ana, expenseId } = await setUp();
      await attach(ana.token, expenseId, JPEG);
      answerWith = () => ({ status: 500, body: {} });
      expect((await attach(ana.token, expenseId, PNG)).status).toBe(424);
      expect((await readReceipt(ana.token, expenseId)).body).toEqual({
        type: 'image/jpeg',
        size: JPEG.length,
        url: 'https://receipts.example/files/file-1',
      });
    });
  });

  describe('deleting the expense', () => {
    it('deletes the receipt with its expense: no receipt of it is read, and none is kept', async () => {
      const { ana, expenseId } = await setUp();
      await attach(ana.token, expenseId, JPEG);
      expect((await send(app, 'DELETE', `/expenses/${expenseId}`, { token: ana.token })).status).toBe(204);
      expect((await readReceipt(ana.token, expenseId)).status).toBe(404);
      const counter: DatabaseSync = openDatabase(directory.databasePath);
      try {
        expect((counter.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n).toBe(0);
      } finally {
        counter.close();
      }
    });
  });

  describe('keeping receipts', () => {
    it('keeps a receipt across restarts, and reads it from the file after them', async () => {
      const { ana, expenseId } = await setUp();
      await attach(ana.token, expenseId, PNG);
      await app.stop();
      app = await createApplication({
        databasePath: directory.databasePath,
        receiptsUrl: serviceUrl,
        receiptsTimeoutMs: 200,
      });
      await app.start(0);
      expect((await readReceipt(ana.token, expenseId)).body).toEqual({
        type: 'image/png',
        size: PNG.length,
        url: 'https://receipts.example/files/file-1',
      });
    });
  });

  describe('without a receipts store', () => {
    it('refuses a receipt with 424, sends nothing, and keeps nothing', async () => {
      const unconfigured = testDirectory();
      const unconfiguredApp = await createApplication({ databasePath: unconfigured.databasePath, receiptsUrl: '' });
      await unconfiguredApp.start(0);
      try {
        const ana = await signedUpAccount(unconfiguredApp, { email: 'ana@example.org', name: 'Ana' });
        const created = await send(unconfiguredApp, 'POST', '/groups', {
          token: ana.token,
          body: { name: 'Flat', currency: 'EUR' },
        });
        const groupId = (created.body as { id: string }).id;
        const recorded = await send(unconfiguredApp, 'POST', `/groups/${groupId}/expenses`, {
          token: ana.token,
          body: { description: 'Groceries', amount: 1000, date: utcDay(0), splitBetween: [ana.id] },
        });
        const expenseId = (recorded.body as { id: string }).id;
        const reply = await sendBytes(unconfiguredApp, 'PUT', `/expenses/${expenseId}/receipt`, {
          token: ana.token,
          bytes: JPEG,
          contentType: 'application/octet-stream',
        });
        expect(reply.status).toBe(424);
        expect(reply.body).toMatchObject({ error: 'ReceiptsNotConfigured' });
        expect(
          (await send(unconfiguredApp, 'GET', `/expenses/${expenseId}/receipt`, { token: ana.token })).status,
        ).toBe(404);
      } finally {
        await unconfiguredApp.stop();
        unconfigured.remove();
      }
    });
  });
});
