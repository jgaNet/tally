import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Application } from './app';
import { RECEIPT_MAX_BYTES } from './receipts';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const JPEG_START = [0xff, 0xd8, 0xff, 0xe0];
const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A file of `size` bytes that starts with `start`, and is zeros after it. */
function fileOf(start: number[], size: number): Buffer {
  const bytes = Buffer.alloc(size);
  Buffer.from(start).copy(bytes, 0, 0, Math.min(start.length, size));
  return bytes;
}

interface StoreRequest {
  path: string;
  contentType: string | undefined;
  body: Buffer;
}

/** What the receipts store answers: its status, and the body, as JSON, or as the `raw` text when given. */
interface StoreAnswer {
  status: number;
  body?: unknown;
  raw?: string;
  delayMs?: number;
}

interface FakeStore {
  url: string;
  requests: StoreRequest[];
  answer: (request: StoreRequest, number: number) => StoreAnswer;
  stop(): Promise<void>;
}

/** A receipts store on a port of its own. By default it keeps every file: `201` with a new id and a link. */
async function startFakeStore(): Promise<FakeStore> {
  const requests: StoreRequest[] = [];
  const store: FakeStore = {
    url: '',
    requests,
    answer: (_request, number) => ({
      status: 201,
      body: { id: `file_${number}`, url: `https://files.example/file_${number}` },
    }),
    stop: async () => undefined,
  };
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const request: StoreRequest = {
        path: incoming.url ?? '',
        contentType: incoming.headers['content-type'],
        body: Buffer.concat(chunks),
      };
      requests.push(request);
      const answer = store.answer(request, requests.length);
      setTimeout(() => {
        outgoing.writeHead(answer.status, { 'content-type': 'application/json' });
        outgoing.end(answer.raw ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)));
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  Object.assign(store, {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return store;
}

/** The answer to a receipt request: its status, and the body, read as JSON by the assertions that look into it. */
interface Attempt {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** The file sent as the body of a receipt request, with its content type. */
async function attach(
  app: Application,
  expenseId: string,
  bytes: Buffer,
  token: string,
  contentType = 'application/octet-stream',
): Promise<Attempt> {
  const response = await fetch(`${app.address}/${app.apiPrefix}/expenses/${expenseId}/receipt`, {
    method: 'PUT',
    headers: { 'content-type': contentType, authorization: `Bearer ${token}` },
    body: new Uint8Array(bytes),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

describe('receipts', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let store: FakeStore;
  let app: Application;
  const extraApps: Application[] = [];
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let outsiderToken: string;
  let groupId: string;
  let expenseId: string;

  const readReceiptRows = (): Array<Record<string, unknown>> => {
    const probe = new DatabaseSync(database.path);
    try {
      return probe.prepare('SELECT * FROM receipts').all() as Array<Record<string, unknown>>;
    } finally {
      probe.close();
    }
  };

  const readReceipt = (id = expenseId, token = adaToken) => call(app, 'GET', `/expenses/${id}/receipt`, { token });

  beforeEach(async () => {
    database = temporaryDatabase();
    store = await startFakeStore();
    app = await startApplication(database.path, { receiptsUrl: store.url });
    adaId = (await call(app, 'POST', '/accounts', { body: ada })).body.id;
    adaToken = (await call(app, 'POST', '/accounts/login', { body: ada })).body.token;
    graceId = (await call(app, 'POST', '/accounts', { body: grace })).body.id;
    graceToken = (await call(app, 'POST', '/accounts/login', { body: grace })).body.token;
    await call(app, 'POST', '/accounts', { body: outsiderAccount });
    outsiderToken = (await call(app, 'POST', '/accounts/login', { body: outsiderAccount })).body.token;
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    expect((await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: graceToken })).status).toBe(
      204,
    );
    // Ada paid 2000 for the groceries, split between her and Grace.
    expenseId = (
      await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: { description: 'Groceries', amount: 2000, date: '2026-11-01', splitBetween: [adaId, graceId] },
        token: adaToken,
      })
    ).body.id;
    store.requests.splice(0);
  });

  afterEach(async () => {
    for (const extra of extraApps.splice(0)) await extra.stop();
    await app.stop();
    await store.stop();
    database.remove();
  });

  describe('attaching a receipt', () => {
    it('sends a JPEG to the store as it is, with its type, and attaches the link the store answers', async () => {
      const jpeg = fileOf(JPEG_START, 1234);
      const answer = await attach(app, expenseId, jpeg, adaToken);
      expect(answer.status).toBe(204);
      expect(store.requests).toEqual([{ path: '/files', contentType: 'image/jpeg', body: jpeg }]);
      const read = await readReceipt();
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ type: 'image/jpeg', size: 1234, url: 'https://files.example/file_1' });
    });

    it('attaches a PNG, and reads its type from its first bytes', async () => {
      const png = fileOf(PNG_START, 512);
      expect((await attach(app, expenseId, png, adaToken)).status).toBe(204);
      expect((await readReceipt()).body).toEqual({
        type: 'image/png',
        size: 512,
        url: 'https://files.example/file_1',
      });
    });

    it('accepts a file of exactly 2 MB, and refuses one byte more before anything is sent', async () => {
      expect((await attach(app, expenseId, fileOf(JPEG_START, RECEIPT_MAX_BYTES), adaToken)).status).toBe(204);
      expect((await readReceipt()).body.size).toBe(RECEIPT_MAX_BYTES);

      store.requests.splice(0);
      const larger = await attach(app, expenseId, fileOf(JPEG_START, RECEIPT_MAX_BYTES + 1), adaToken);
      expect(larger.status).toBe(413);
      expect(store.requests).toEqual([]);
      expect((await readReceipt()).body).toEqual({
        type: 'image/jpeg',
        size: RECEIPT_MAX_BYTES,
        url: 'https://files.example/file_1',
      });
    });

    it('refuses an empty file, and sends nothing to the store', async () => {
      const answer = await attach(app, expenseId, Buffer.alloc(0), adaToken);
      expect(answer.status).toBe(422);
      expect(answer.body.type).toBe('InvalidReceipt');
      expect(store.requests).toEqual([]);
      expect((await readReceipt()).status).toBe(404);
    });

    it('refuses a file that is neither a JPEG nor a PNG, and sends nothing to the store', async () => {
      const gif = Buffer.from('GIF89a........', 'ascii');
      const text = Buffer.from('Groceries, 87 euros', 'utf8');
      // A JPEG's first three bytes are FF D8 FF, and a PNG's first eight: a near miss is not either.
      const nearJpeg = fileOf([0xff, 0xd8, 0x00], 100);
      const nearPng = fileOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00], 100);
      for (const bytes of [gif, text, nearJpeg, nearPng]) {
        const answer = await attach(app, expenseId, bytes, adaToken);
        expect(answer.status).toBe(422);
        expect(answer.body.type).toBe('InvalidReceipt');
      }
      expect(store.requests).toEqual([]);
    });

    it('refuses a body sent as another content type than application/octet-stream', async () => {
      const answer = await attach(app, expenseId, fileOf(JPEG_START, 100), adaToken, 'image/jpeg');
      expect(answer.status).toBe(415);
      expect(store.requests).toEqual([]);
    });

    it('refuses a receipt on a server with no receipts store, and changes nothing', async () => {
      const unconfigured = await startApplication(temporaryDatabase().path, { receiptsUrl: '' });
      extraApps.push(unconfigured);
      const ownId = (await call(unconfigured, 'POST', '/accounts', { body: ada })).body.id;
      const token = (await call(unconfigured, 'POST', '/accounts/login', { body: ada })).body.token;
      const group = (
        await call(unconfigured, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token })
      ).body.id;
      const expense = (
        await call(unconfigured, 'POST', `/groups/${group}/expenses`, {
          body: { description: 'Groceries', amount: 2000, date: '2026-11-01', splitBetween: [ownId] },
          token,
        })
      ).body.id;
      const answer = await attach(unconfigured, expense, fileOf(JPEG_START, 100), token);
      expect(answer.status).toBe(409);
      expect(answer.body.type).toBe('ReceiptsNotConfigured');
      expect((await call(unconfigured, 'GET', `/expenses/${expense}/receipt`, { token })).status).toBe(404);
    });

    it('refuses when the store answers anything but 201 with an id and a link, and attaches nothing', async () => {
      const refusals: StoreAnswer[] = [
        { status: 500, raw: 'boom' },
        { status: 200, body: { id: 'file_1', url: 'https://files.example/file_1' } },
        { status: 201, body: { url: 'https://files.example/file_1' } },
        { status: 201, body: { id: 'file_1' } },
        { status: 201, body: { id: '', url: 'https://files.example/file_1' } },
        { status: 201, raw: 'not json' },
      ];
      for (const refusal of refusals) {
        store.answer = () => refusal;
        const answer = await attach(app, expenseId, fileOf(JPEG_START, 100), adaToken);
        expect(answer.status).toBe(424);
        expect(answer.body.type).toBe('ReceiptsUnavailable');
      }
      expect((await readReceipt()).status).toBe(404);
    });

    it('refuses when the store does not answer within the time allowed, and attaches nothing', async () => {
      await app.stop();
      app = await startApplication(database.path, { receiptsUrl: store.url, receiptsTimeoutMs: 100 });
      store.answer = (_request, number) => ({
        status: 201,
        body: { id: `file_${number}`, url: `https://files.example/file_${number}` },
        delayMs: 1000,
      });
      const answer = await attach(app, expenseId, fileOf(JPEG_START, 100), adaToken);
      expect(answer.status).toBe(424);
      expect(answer.body.type).toBe('ReceiptsUnavailable');
      expect((await readReceipt()).status).toBe(404);
    });

    it('replaces the receipt the expense had, and keeps one per expense', async () => {
      await attach(app, expenseId, fileOf(JPEG_START, 100), adaToken);
      await attach(app, expenseId, fileOf(PNG_START, 300), adaToken);
      expect((await readReceipt()).body).toEqual({
        type: 'image/png',
        size: 300,
        url: 'https://files.example/file_2',
      });
      expect(readReceiptRows()).toHaveLength(1);
    });

    it('is not an edit: the expense keeps its version, and an edit from the version read still lands', async () => {
      await attach(app, expenseId, fileOf(JPEG_START, 100), adaToken);
      const expense = (await call(app, 'GET', `/expenses/${expenseId}`, { token: adaToken })).body;
      expect(expense.version).toBe(1);
      const edit = await call(app, 'PUT', `/expenses/${expenseId}`, {
        body: {
          description: 'Groceries',
          amount: 2000,
          date: '2026-11-01',
          version: 1,
          splitBetween: [adaId, graceId],
        },
        token: adaToken,
      });
      expect(edit.status).toBe(204);
    });

    it('lets the payer of the expense attach a receipt, as the owner of the group may', async () => {
      const graceExpense = (
        await call(app, 'POST', `/groups/${groupId}/expenses`, {
          body: { description: 'Milk', amount: 300, date: '2026-11-02', splitBetween: [adaId, graceId] },
          token: graceToken,
        })
      ).body.id;
      expect((await attach(app, graceExpense, fileOf(JPEG_START, 100), graceToken)).status).toBe(204);
      expect((await attach(app, graceExpense, fileOf(JPEG_START, 100), adaToken)).status).toBe(204);
    });

    it('refuses a member who is neither the payer nor the owner, and a stranger finds no expense to attach to', async () => {
      const refused = await attach(app, expenseId, fileOf(JPEG_START, 100), graceToken);
      expect(refused.status).toBe(403);
      expect(refused.body.type).toBe('NotAllowed');
      expect((await attach(app, expenseId, fileOf(JPEG_START, 100), outsiderToken)).status).toBe(404);
      expect(store.requests).toEqual([]);
    });
  });

  describe('reading a receipt', () => {
    it('answers the type, size and link of the receipt to any member of the group', async () => {
      await attach(app, expenseId, fileOf(JPEG_START, 4096), adaToken);
      expect((await readReceipt(expenseId, graceToken)).body).toEqual({
        type: 'image/jpeg',
        size: 4096,
        url: 'https://files.example/file_1',
      });
    });

    it('answers 404 for an expense without a receipt', async () => {
      const answer = await readReceipt();
      expect(answer.status).toBe(404);
      expect(answer.body.type).toBe('NotFound');
    });

    it('answers 404 to someone outside the group', async () => {
      await attach(app, expenseId, fileOf(JPEG_START, 100), adaToken);
      expect((await readReceipt(expenseId, outsiderToken)).status).toBe(404);
    });

    it('changes nothing and asks the store for nothing', async () => {
      await attach(app, expenseId, fileOf(JPEG_START, 100), adaToken);
      store.requests.splice(0);
      const before = readReceiptRows();
      await readReceipt();
      await readReceipt(expenseId, graceToken);
      expect(store.requests).toEqual([]);
      expect(readReceiptRows()).toEqual(before);
    });
  });

  it('removes the receipt with its expense', async () => {
    await attach(app, expenseId, fileOf(JPEG_START, 100), adaToken);
    expect((await call(app, 'DELETE', `/expenses/${expenseId}`, { token: adaToken })).status).toBe(204);
    expect(readReceiptRows()).toEqual([]);
  });
});
