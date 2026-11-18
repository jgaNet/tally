import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * Request 26: a receipt, a JPEG or a PNG of at most 2 MB, attached by the payer of an expense or the owner of its group,
 * kept in the receipts store (RECEIPTS_URL), and read by a member of the group.
 */

type Body = Record<string, unknown>;

/** A stand-in for the receipts store: it keeps each file it is sent and answers `201 { id, url }`. */
let store: Server;
let stored: { contentType?: string; bytes: Buffer }[] = [];
let refusing = false;

const JPEG_START = [0xff, 0xd8, 0xff, 0xe0];
const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A file of `size` bytes that starts with `start`. */
function fileStarting(start: number[], size: number): Buffer {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from(start).copy(bytes);
  return bytes;
}

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  store = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/files' || refusing) {
        res.writeHead(500).end();
        return;
      }
      stored.push({ contentType: req.headers['content-type'], bytes: Buffer.concat(chunks) });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `file-${stored.length}`, url: `https://receipts.example/file-${stored.length}` }));
    });
  });
  await new Promise<void>(resolve => store.listen(0, '127.0.0.1', () => resolve()));
  process.env.RECEIPTS_URL = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'receipts-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(async () => {
  delete process.env.RECEIPTS_URL;
  await app.stop();
  await new Promise(resolve => store.close(resolve));
});

beforeEach(() => {
  stored = [];
  refusing = false;
});

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-receipts-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group in euros: Alice (its owner) and Bob, who joined after her. */
async function twoMembers() {
  const alice = await person('Alice');
  const bob = await person('Bob');
  const created = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: alice.token,
  });
  const groupId = (
    (await outcome((created.body as Body).operationId as string, alice.token)).body as { result: { id: string } }
  ).result.id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: alice.token });
  const invitationId = (
    (await outcome((invitation.body as Body).operationId as string, alice.token)).body as { result: { id: string } }
  ).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: bob.token });
  await outcome((accepted.body as Body).operationId as string, bob.token);
  return { alice, bob, groupId };
}

/** Records an expense split between the two, paid by `payer`, and answers its id. */
async function recordExpense(payer: { token: string; id: string }, other: { id: string }, groupId: string) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Groceries', amount: 8700, date: serverToday, splitBetween: [payer.id, other.id] },
    token: payer.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, payer.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** Sends a receipt as a client does: the `202`, then the operation followed to its outcome. */
async function attach(token: string | undefined, expenseId: string, bytes: Buffer) {
  const answer = await http.request('PUT', `${api}/expenses/${expenseId}/receipt`, {
    body: bytes,
    token,
    headers: { 'content-type': 'application/octet-stream' },
  });
  if (answer.status !== 202) return { answer, done: undefined as Body | undefined };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { answer, done: done.body as Body };
}

const receiptOf = (expenseId: string, token: string) => http.get(`${api}/expenses/${expenseId}/receipt`, { token });

describe('attaching a receipt (request 26)', () => {
  it('attaches a JPEG: the store keeps the file as sent, and a member reads its type, size and link', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const expenseId = await recordExpense(alice, bob, groupId);
    const bytes = fileStarting(JPEG_START, 1000);

    const { answer, done } = await attach(alice.token, expenseId, bytes);
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'SUCCESS' });

    expect(stored).toHaveLength(1);
    expect(stored[0].contentType).toBe('image/jpeg');
    expect(stored[0].bytes.equals(bytes)).toBe(true);
    const read = await receiptOf(expenseId, bob.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ type: 'image/jpeg', size: 1000, url: 'https://receipts.example/file-1' });
  });

  it('replaces the receipt with a PNG, which the expense keeps its version through', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const expenseId = await recordExpense(alice, bob, groupId);
    const before = (await http.get(`${api}/expenses/${expenseId}`, { token: alice.token })).body as { version: number };

    await attach(alice.token, expenseId, fileStarting(JPEG_START, 500));
    const replaced = await attach(alice.token, expenseId, fileStarting(PNG_START, 600));
    expect(replaced.done).toMatchObject({ status: 'SUCCESS' });

    expect((await receiptOf(expenseId, alice.token)).body).toEqual({
      type: 'image/png',
      size: 600,
      url: 'https://receipts.example/file-2',
    });
    const after = (await http.get(`${api}/expenses/${expenseId}`, { token: alice.token })).body as { version: number };
    expect(after.version).toBe(before.version);
  });

  it('lets the owner of the group attach to an expense another member paid', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const expenseId = await recordExpense(bob, alice, groupId);
    const { done } = await attach(alice.token, expenseId, fileStarting(PNG_START, 40));
    expect(done).toMatchObject({ status: 'SUCCESS' });
  });

  it('refuses a member who neither paid the expense nor owns the group, by name', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const carol = await person('Carol');
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: alice.token });
    const invitationId = (
      (await outcome((invitation.body as Body).operationId as string, alice.token)).body as { result: { id: string } }
    ).result.id;
    const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: carol.token });
    await outcome((accepted.body as Body).operationId as string, carol.token);

    const expenseId = await recordExpense(alice, bob, groupId);
    const { done } = await attach(carol.token, expenseId, fileStarting(JPEG_START, 40));
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NotAllowedToAttachReceipt' } });
    expect(stored).toHaveLength(0);
  });

  it.each([
    ['an empty file', Buffer.alloc(0), 'InvalidReceiptSize'],
    ['a file of 2 MB and 1 byte', fileStarting(JPEG_START, 2097153), 'InvalidReceiptSize'],
    ['a GIF', Buffer.from('GIF89a......'), 'UnsupportedReceiptType'],
    ['a PNG cut short', fileStarting(PNG_START.slice(0, 7), 7), 'UnsupportedReceiptType'],
  ])('refuses %s behind the 202, by name, and sends nothing to the store', async (_, bytes, type) => {
    const { alice, bob, groupId } = await twoMembers();
    const expenseId = await recordExpense(alice, bob, groupId);
    const { answer, done } = await attach(alice.token, expenseId, bytes);
    expect(answer.status).toBe(202);
    expect(done).toMatchObject({ status: 'ERROR', error: { type, message: expect.any(String) } });
    expect(stored).toHaveLength(0);
  });

  it('keeps a file of exactly 2 MB', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const expenseId = await recordExpense(alice, bob, groupId);
    const { done } = await attach(alice.token, expenseId, fileStarting(JPEG_START, 2097152));
    expect(done).toMatchObject({ status: 'SUCCESS' });
    expect((await receiptOf(expenseId, alice.token)).body).toMatchObject({ size: 2097152 });
  });

  it('refuses the receipt when the store does not keep the file, and nothing is attached', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const expenseId = await recordExpense(alice, bob, groupId);
    refusing = true;
    const { done } = await attach(alice.token, expenseId, fileStarting(JPEG_START, 40));
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'ReceiptStoreUnavailable' } });
    expect((await receiptOf(expenseId, alice.token)).status).toBe(404);
  });

  it('refuses at once with 401 to a caller not signed in, and answers 404 for an expense that does not exist', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const expenseId = await recordExpense(alice, bob, groupId);
    const anonymous = await attach(undefined, expenseId, fileStarting(JPEG_START, 40));
    expect(anonymous.answer.status).toBe(401);
    expect(stored).toHaveLength(0);

    const { done } = await attach(alice.token, '00000000-0000-0000-0000-000000000000', fileStarting(JPEG_START, 40));
    expect(done).toMatchObject({ status: 'ERROR', error: { type: 'NotFound' } });
  });
});

describe('reading a receipt (request 26)', () => {
  it('answers 404 for an expense with no receipt, and 404 to someone outside the group', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const expenseId = await recordExpense(alice, bob, groupId);
    expect((await receiptOf(expenseId, bob.token)).status).toBe(404);

    const stranger = await person('Stranger');
    await attach(alice.token, expenseId, fileStarting(JPEG_START, 40));
    expect((await receiptOf(expenseId, stranger.token)).status).toBe(404);
  });

  it('answers 401 to a caller who is not signed in', async () => {
    const { alice, bob, groupId } = await twoMembers();
    const expenseId = await recordExpense(alice, bob, groupId);
    const answer = await http.get(`${api}/expenses/${expenseId}/receipt`);
    expect(answer.status).toBe(401);
  });
});

describe('Groups → Ledger (GroupMembers)', () => {
  it('records an expense and attaches its receipt in the group Groups made, under the id that group was answered', async () => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: alice.token,
    });
    const groupId = (
      (await outcome((created.body as Body).operationId as string, alice.token)).body as { result: { id: string } }
    ).result.id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: alice.token });
    const invitationId = (
      (await outcome((invitation.body as Body).operationId as string, alice.token)).body as { result: { id: string } }
    ).result.id;
    const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: bob.token });
    await outcome((accepted.body as Body).operationId as string, bob.token);

    const expenseId = await recordExpense(alice, bob, groupId);
    const expense = (await http.get(`${api}/expenses/${expenseId}`, { token: alice.token })).body as {
      groupId: string;
    };
    expect(expense.groupId).toBe(groupId);

    const { done } = await attach(alice.token, expenseId, fileStarting(JPEG_START, 300));
    expect(done).toMatchObject({ status: 'SUCCESS' });
    expect((await receiptOf(expenseId, bob.token)).body).toMatchObject({ type: 'image/jpeg', size: 300 });
  });
});
