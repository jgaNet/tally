import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeReceiptsStore,
  joinThroughInvitation,
  send,
  signedUpAccount,
  startFakeReceiptsStore,
  temporaryDatabasePath,
} from '../test-support';

const MAX = 2097152;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A file of `size` bytes that starts with `signature`, the rest zeros. */
const fileStarting = (signature: number[], size: number): Buffer => {
  const bytes = Buffer.alloc(size);
  Buffer.from(signature).copy(bytes);
  return bytes;
};
const jpeg = (size = 1024) => fileStarting(JPEG_SIGNATURE, size);
const png = (size = 1024) => fileStarting(PNG_SIGNATURE, size);

describe('receipts', () => {
  let app: Application;
  let store: FakeReceiptsStore;

  beforeEach(async () => {
    store = await startFakeReceiptsStore();
    app = await createApplication({
      databasePath: temporaryDatabasePath(),
      receiptsUrl: store.url,
      receiptsTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    await app.stop();
    await store.close();
  });

  /** Answers with a new application whose store is given up after `timeoutMs`, for a store that hangs. */
  async function withStoreTimeout(timeoutMs: number): Promise<void> {
    await app.stop();
    app = await createApplication({
      databasePath: temporaryDatabasePath(),
      receiptsUrl: store.url,
      receiptsTimeoutMs: timeoutMs,
    });
  }

  async function createdGroup(token: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** Ada owns a group with Grace in it; answers their ids and tokens, and the group's id. */
  async function twoMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    return { ada, grace, groupId };
  }

  async function recordExpense(token: string, groupId: string, splitBetween: string[]): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      payload: { description: 'Groceries', amount: 8700, date: todayInUtc(), splitBetween },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function attach(token: string, expenseId: string, file: Buffer, contentType = 'application/octet-stream') {
    return send(app, 'PUT', `/expenses/${expenseId}/receipt`, {
      token,
      payload: file,
      headers: { 'content-type': contentType },
    });
  }

  async function readReceipt(token: string, expenseId: string) {
    return send(app, 'GET', `/expenses/${expenseId}/receipt`, { token });
  }

  describe('attaching', () => {
    it('keeps a JPEG in the store, and reads its type, its size and its link', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);
      const file = jpeg(4096);

      expect((await attach(ada.token, expenseId, file)).statusCode).toBe(204);

      expect(store.requests).toHaveLength(1);
      expect(store.requests[0].contentType).toBe('image/jpeg');
      expect(store.requests[0].bytes.equals(file)).toBe(true);
      const read = await readReceipt(ada.token, expenseId);
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ type: 'image/jpeg', size: 4096, url: 'https://files.example.test/file-1' });
    });

    it('keeps a PNG in the store, sent as a PNG', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);

      expect((await attach(ada.token, expenseId, png(300))).statusCode).toBe(204);

      expect(store.requests[0].contentType).toBe('image/png');
      expect((await readReceipt(ada.token, expenseId)).json()).toEqual({
        type: 'image/png',
        size: 300,
        url: 'https://files.example.test/file-1',
      });
    });

    it('takes a file of exactly 2 MB, and refuses one byte more', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);

      expect((await attach(ada.token, expenseId, jpeg(MAX))).statusCode).toBe(204);
      expect((await readReceipt(ada.token, expenseId)).json().size).toBe(MAX);

      const larger = await attach(ada.token, expenseId, jpeg(MAX + 1));
      expect(larger.statusCode).toBe(413);
      expect(store.requests).toHaveLength(1);
    });

    it('refuses a file that is neither a JPEG nor a PNG, without asking the store', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);
      const notReceipts = [
        Buffer.from('%PDF-1.7 not an image'),
        fileStarting([0xff, 0xd8, 0x00], 100), // JPEG's first two bytes only
        fileStarting([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00], 100), // PNG signature, but wrong last byte
        Buffer.from([0xff]),
      ];
      for (const file of notReceipts) {
        const response = await attach(ada.token, expenseId, file);
        expect(response.statusCode).toBe(422);
        expect(response.json()).toEqual({ type: 'NotAReceipt', message: expect.any(String) });
      }
      expect(store.requests).toHaveLength(0);
      expect((await readReceipt(ada.token, expenseId)).statusCode).toBe(404);
    });

    it('refuses an empty file, without asking the store', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);

      expect((await attach(ada.token, expenseId, Buffer.alloc(0))).statusCode).toBe(422);
      const noBody = await send(app, 'PUT', `/expenses/${expenseId}/receipt`, {
        token: ada.token,
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(noBody.statusCode).toBe(422);
      expect(store.requests).toHaveLength(0);
    });

    it('refuses a body that is not sent as octet-stream', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);

      const response = await attach(ada.token, expenseId, jpeg(), 'image/jpeg');
      expect(response.statusCode).toBe(415);
      expect(store.requests).toHaveLength(0);
    });

    it('does not change the expense, whose version stays as it was', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);

      await attach(ada.token, expenseId, jpeg());

      const expense = await send(app, 'GET', `/expenses/${expenseId}`, { token: ada.token });
      expect(expense.json().version).toBe(1);
    });

    it('replaces the receipt the expense had', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);
      await attach(ada.token, expenseId, jpeg(500));

      expect((await attach(ada.token, expenseId, png(200))).statusCode).toBe(204);

      expect((await readReceipt(ada.token, expenseId)).json()).toEqual({
        type: 'image/png',
        size: 200,
        url: 'https://files.example.test/file-2',
      });
    });

    it('is allowed to the payer and to the owner, and refused to another member with 403', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const expenseId = await recordExpense(grace.token, groupId, [grace.id]);

      expect((await attach(grace.token, expenseId, jpeg())).statusCode).toBe(204);
      expect((await attach(ada.token, expenseId, png())).statusCode).toBe(204);

      const otherExpense = await recordExpense(ada.token, groupId, [ada.id]);
      const refused = await attach(grace.token, otherExpense, jpeg());
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ type: 'NotPermitted', message: expect.any(String) });
    });

    it('is refused to someone outside the group as if the expense did not exist', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);
      const outsider = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });

      expect((await attach(outsider.token, expenseId, jpeg())).statusCode).toBe(404);
      expect(store.requests).toHaveLength(0);
    });

    it('is refused to an expense that names a member who has left, as an edit is', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const expenseId = await recordExpense(grace.token, groupId, [grace.id]);
      const left = await send(app, 'POST', `/groups/${groupId}/leave`, { token: grace.token });
      expect(left.statusCode).toBe(204);

      const refused = await attach(ada.token, expenseId, jpeg());
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ type: 'MemberHasLeft', message: expect.any(String) });
      expect(store.requests).toHaveLength(0);
    });

    it('is refused when no receipts store is set up, and nothing is sent', async () => {
      await app.stop();
      app = await createApplication({ databasePath: temporaryDatabasePath() });
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);

      const response = await attach(ada.token, expenseId, jpeg());
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ type: 'ReceiptsNotConfigured', message: expect.any(String) });
      expect(store.requests).toHaveLength(0);
    });
  });

  describe('when the store does not keep the file', () => {
    it.each([
      ['refuses it', 'refuse'],
      ['answers without a link', 'malformed'],
      ['does not answer in time', 'hang'],
    ] as const)('refuses the receipt when the store %s, and keeps nothing', async (_, mode) => {
      if (mode === 'hang') {
        await withStoreTimeout(300);
      }
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);
      store.mode = mode;

      const response = await attach(ada.token, expenseId, jpeg());
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ type: 'ReceiptNotStored', message: expect.any(String) });
      expect((await readReceipt(ada.token, expenseId)).statusCode).toBe(404);
    });

    it('keeps the receipt the expense had when a replacement is not stored', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);
      await attach(ada.token, expenseId, jpeg(700));
      store.mode = 'refuse';

      expect((await attach(ada.token, expenseId, png(900))).statusCode).toBe(409);

      expect((await readReceipt(ada.token, expenseId)).json()).toEqual({
        type: 'image/jpeg',
        size: 700,
        url: 'https://files.example.test/file-1',
      });
    });
  });

  describe('reading', () => {
    it('answers 404 for an expense without a receipt', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);

      expect((await readReceipt(ada.token, expenseId)).statusCode).toBe(404);
    });

    it('lets any member of the group read it, and tells anyone else it does not exist', async () => {
      const { ada, grace, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);
      await attach(ada.token, expenseId, jpeg(64));
      const outsider = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });

      expect((await readReceipt(grace.token, expenseId)).statusCode).toBe(200);
      expect((await readReceipt(outsider.token, expenseId)).statusCode).toBe(404);
    });

    it('is not changed by a read', async () => {
      const { ada, groupId } = await twoMembers();
      const expenseId = await recordExpense(ada.token, groupId, [ada.id]);
      await attach(ada.token, expenseId, jpeg(64));

      const first = await readReceipt(ada.token, expenseId);
      const second = await readReceipt(ada.token, expenseId);
      expect(second.json()).toEqual(first.json());
      expect(store.requests).toHaveLength(1);
    });
  });

  it('removes the receipt with its expense when the expense is deleted', async () => {
    const { ada, groupId } = await twoMembers();
    const expenseId = await recordExpense(ada.token, groupId, [ada.id]);
    await attach(ada.token, expenseId, jpeg());

    expect((await send(app, 'DELETE', `/expenses/${expenseId}`, { token: ada.token })).statusCode).toBe(204);
    expect((await readReceipt(ada.token, expenseId)).statusCode).toBe(404);
  });
});
