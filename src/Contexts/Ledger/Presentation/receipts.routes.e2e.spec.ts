import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('receipts');

/**
 * The receipts store, as a server of its own: it keeps each file it is sent as `POST /files` and answers `201 { id, url }`, or what the test
 * says. Request 26's suite reads what Tally sent it, and answers what the test sets.
 */
let storeAnswer: { status: number; body?: string } | undefined;
let storeRequests: Array<{ contentType?: string; bytes: Buffer; answered?: string }> = [];
let fileCount = 0;
let storeServer: Server;
let storeOrigin: string;

const readAll = (request: IncomingMessage): Promise<Buffer> =>
  new Promise(resolve => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  storeServer = createServer(async (request, response) => {
    const bytes = await readAll(request);
    if (request.method === 'POST' && request.url === '/files') {
      fileCount += 1;
      const url = `https://receipts.example/files/file-${fileCount}`;
      const answer = storeAnswer ?? { status: 201, body: JSON.stringify({ id: `file-${fileCount}`, url }) };
      // What the store answered is recorded with what it was sent: the link a receipt is read at is the last one answered.
      storeRequests.push({
        contentType: request.headers['content-type'],
        bytes,
        answered: answer.status === 201 ? url : undefined,
      });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body ?? '');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => storeServer.listen(0, '127.0.0.1', () => resolve()));
  storeOrigin = `http://127.0.0.1:${(storeServer.address() as AddressInfo).port}`;

  process.env.RECEIPTS_URL = storeOrigin;
  await database;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise<void>(resolve => storeServer.close(() => resolve()));
  delete process.env.RECEIPTS_URL;
});
beforeEach(() => {
  storeAnswer = undefined;
  storeRequests = [];
});

const PASSWORD = 'a-good-password';
const DAY = '2026-01-10';

/** A JPEG or a PNG of `size` bytes, starting with the bytes its type is read from. */
const jpeg = (size = 64): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};
const png = (size = 64): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group with its owner as first member, and each given account joined by an invitation, in that order. */
async function groupWith(owner: { token: string }, joiners: Array<{ token: string }>): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  for (const joiner of joiners) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

/** An expense of the group, paid by `payer` and split equally between the given members. */
async function expenseOf(payer: { token: string; id: string }, groupId: string, between: string[]): Promise<string> {
  const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: payer.token,
    body: { description: 'Groceries', amount: 8700, date: DAY, paidBy: payer.id, splitBetween: between },
  });
  return (recorded.body as { id: string }).id;
}

const attach = (token: string, expenseId: string, bytes: Uint8Array) =>
  http.request('PUT', `${api}/expenses/${expenseId}/receipt`, {
    token,
    file: { bytes, contentType: 'application/octet-stream' },
  });
const readReceipt = (token: string, expenseId: string) =>
  http.request('GET', `${api}/expenses/${expenseId}/receipt`, { token });
const readExpense = (token: string, expenseId: string) =>
  http.request('GET', `${api}/expenses/${expenseId}`, { token });

describe('receipts (request 26)', () => {
  it('is attached by the payer, read back with its type, its size and the store link, and has none until it is attached', async () => {
    const ada = await signedIn('rcpt-ada@example.com', 'Ada');
    const bob = await signedIn('rcpt-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);
    const expenseId = await expenseOf(bob, groupId, [ada.id, bob.id]);

    expect((await readReceipt(bob.token, expenseId)).status).toBe(404);

    const attached = await attach(bob.token, expenseId, jpeg(300));
    expect(attached.status).toBe(204);
    expect(storeRequests).toHaveLength(1);
    expect(storeRequests[0].contentType).toBe('image/jpeg');
    expect(storeRequests[0].bytes.length).toBe(300);

    const read = await readReceipt(ada.token, expenseId);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ type: 'image/jpeg', size: 300, url: storeRequests[0].answered });
  });

  it('is replaced by a PNG the owner attaches; the expense keeps its version', async () => {
    const ada = await signedIn('rcpt-owner@example.com', 'Owen');
    const bob = await signedIn('rcpt-payer@example.com', 'Pia');
    const groupId = await groupWith(ada, [bob]);
    const expenseId = await expenseOf(bob, groupId, [ada.id, bob.id]);
    const before = (await readExpense(bob.token, expenseId)).body as { version: number };

    expect((await attach(bob.token, expenseId, jpeg())).status).toBe(204);
    expect((await attach(ada.token, expenseId, png(1000))).status).toBe(204);

    const read = await readReceipt(bob.token, expenseId);
    expect(read.body).toEqual({ type: 'image/png', size: 1000, url: storeRequests[1].answered });
    const after = (await readExpense(bob.token, expenseId)).body as { version: number };
    expect(after.version).toBe(before.version);
  });

  it('is refused to a member who is neither the payer nor the owner, and nothing is sent to the store', async () => {
    const ada = await signedIn('rcpt-ow2@example.com', 'Ola');
    const bob = await signedIn('rcpt-pa2@example.com', 'Ben');
    const cy = await signedIn('rcpt-cy2@example.com', 'Cy');
    const groupId = await groupWith(ada, [bob, cy]);
    const expenseId = await expenseOf(bob, groupId, [ada.id, bob.id, cy.id]);

    const refused = await attach(cy.token, expenseId, jpeg());
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ type: 'NotAllowed' });
    expect(storeRequests).toEqual([]);
    expect((await readReceipt(cy.token, expenseId)).status).toBe(404);
  });

  it('is not shown to a stranger, who is answered as if the expense did not exist', async () => {
    const ada = await signedIn('rcpt-ow3@example.com', 'Ana');
    const bob = await signedIn('rcpt-pa3@example.com', 'Bo');
    const eve = await signedIn('rcpt-eve@example.com', 'Eve');
    const groupId = await groupWith(ada, [bob]);
    const expenseId = await expenseOf(bob, groupId, [ada.id, bob.id]);
    expect((await attach(bob.token, expenseId, jpeg())).status).toBe(204);

    expect((await attach(eve.token, expenseId, jpeg())).status).toBe(404);
    expect((await readReceipt(eve.token, expenseId)).status).toBe(404);
    expect(storeRequests).toHaveLength(1);
  });

  it('refuses a file that is not a JPEG or a PNG, an empty one, or one larger than 2 MB, and sends none of them', async () => {
    const ada = await signedIn('rcpt-ow4@example.com', 'Ava');
    const bob = await signedIn('rcpt-pa4@example.com', 'Bet');
    const groupId = await groupWith(ada, [bob]);
    const expenseId = await expenseOf(bob, groupId, [ada.id, bob.id]);

    const gif = await attach(bob.token, expenseId, new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
    expect(gif.status).toBe(422);
    expect(gif.body).toMatchObject({ type: 'ReceiptNotJpegOrPng' });

    const empty = await attach(bob.token, expenseId, new Uint8Array(0));
    expect(empty.status).toBe(422);
    expect(empty.body).toMatchObject({ type: 'ReceiptSizeOutOfRange' });

    const tooLarge = await attach(bob.token, expenseId, jpeg(2097153));
    expect(tooLarge.status).toBe(422);
    expect(tooLarge.body).toMatchObject({ type: 'ReceiptSizeOutOfRange' });
    expect(storeRequests).toEqual([]);

    // A file of exactly 2 MB is the largest one allowed.
    expect((await attach(bob.token, expenseId, jpeg(2097152))).status).toBe(204);
    expect(storeRequests).toHaveLength(1);
  });

  it('is refused when the store keeps no file, and the receipt the expense had stays as it was', async () => {
    const ada = await signedIn('rcpt-ow5@example.com', 'Ada5');
    const bob = await signedIn('rcpt-pa5@example.com', 'Bob5');
    const groupId = await groupWith(ada, [bob]);
    const expenseId = await expenseOf(bob, groupId, [ada.id, bob.id]);

    storeAnswer = { status: 500, body: '{}' };
    const refused = await attach(bob.token, expenseId, jpeg());
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'ReceiptStoreUnavailable' });
    expect((await readReceipt(bob.token, expenseId)).status).toBe(404);

    storeAnswer = undefined;
    expect((await attach(bob.token, expenseId, jpeg())).status).toBe(204);
    const kept = storeRequests[storeRequests.length - 1].answered;
    storeAnswer = { status: 503, body: 'down' };
    expect((await attach(bob.token, expenseId, png())).status).toBe(422);
    expect(storeRequests).toHaveLength(3);
    expect((await readReceipt(bob.token, expenseId)).body).toEqual({ type: 'image/jpeg', size: 64, url: kept });
  });

  it('is refused while RECEIPTS_URL is not set: no receipt is kept', async () => {
    const ada = await signedIn('rcpt-ow6@example.com', 'Aud');
    const bob = await signedIn('rcpt-pa6@example.com', 'Bea');
    const groupId = await groupWith(ada, [bob]);
    const expenseId = await expenseOf(bob, groupId, [ada.id, bob.id]);

    const url = process.env.RECEIPTS_URL;
    delete process.env.RECEIPTS_URL;
    try {
      const refused = await attach(bob.token, expenseId, jpeg());
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ type: 'ReceiptStoreUnavailable' });
    } finally {
      process.env.RECEIPTS_URL = url;
    }
    expect(storeRequests).toEqual([]);
  });

  it('answers 401 to a missing caller, for the attach and for the read', async () => {
    const ada = await signedIn('rcpt-ow7@example.com', 'Ann');
    const bob = await signedIn('rcpt-pa7@example.com', 'Ben7');
    const groupId = await groupWith(ada, [bob]);
    const expenseId = await expenseOf(bob, groupId, [ada.id, bob.id]);

    expect((await attach('', expenseId, jpeg())).status).toBe(401);
    expect((await readReceipt('', expenseId)).status).toBe(401);
    expect(storeRequests).toEqual([]);
  });
});

describe('Groups → Ledger', () => {
  it('attaches a receipt to an expense of the group Groups made, by a member who has just joined, and reads it back in that group', async () => {
    const ada = await signedIn('rg-ada@example.com', 'Ada');
    const bob = await signedIn('rg-bob@example.com', 'Bob');
    // The group is made through Groups' API, and its id is the one that request answered.
    const group = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    const groupId = (group.body as { id: string }).id;
    // Bob joins through Groups: the membership Groups committed is the one the receipt is checked against (ADR 0004, ADR 0025).
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });

    const expenseId = await expenseOf(bob, groupId, [ada.id, bob.id]);
    expect((await attach(bob.token, expenseId, jpeg(128))).status).toBe(204);

    // Ledger finds the expense by the group's id, and the receipt by the expense's.
    const listed = (await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: ada.token }))
      .body as Array<{
      id: string;
      groupId: string;
    }>;
    expect(listed.find(expense => expense.id === expenseId)?.groupId).toBe(groupId);
    expect((await readReceipt(ada.token, expenseId)).body).toEqual({
      type: 'image/jpeg',
      size: 128,
      url: storeRequests[storeRequests.length - 1].answered,
    });
  });
});
