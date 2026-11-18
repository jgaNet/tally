import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * A receipt, end to end (request 26): the application booted in this process, spoken to over HTTP, every answer held to
 * api/26-receipts.yaml by the client. The receipts store is a fake one, a server in this process that records the files it is
 * sent, so a test can tell what was sent and what was not. The application reads RECEIPTS_URL when a receipt is attached, so an
 * unset URL is a server with no store at all. The group counts in EUR.
 */
const PASSWORD = 'correct horse';
const SPENT = '2020-01-02';

/** The files the fake store was sent, in order, with the type each was sent as. */
let stored: { contentType: string | undefined; bytes: Buffer }[] = [];
/** What the fake store does with a file: keeps it, fails with 500, or answers after the 5-second deadline. */
let mode: 'keep' | 'fail' | 'slow' = 'keep';

let storeServer: Server;
let storeUrl: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 9)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100, 1)]);
const LARGEST_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2_097_152 - 3, 5)]);
const TOO_LARGE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2_097_152 - 2, 5)]);

beforeAll(async () => {
  storeServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const answered = () => {
        if (mode === 'fail') return void res.writeHead(500).end();
        stored.push({ contentType: req.headers['content-type'], bytes: Buffer.concat(chunks) });
        const id = String(stored.length);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, url: `${storeUrl}/files/${id}` }));
      };
      if (mode === 'slow') setTimeout(answered, 5500);
      else answered();
    });
  });
  await new Promise<void>(resolve => storeServer.listen(0, '127.0.0.1', resolve));
  storeUrl = `http://127.0.0.1:${(storeServer.address() as AddressInfo).port}`;

  process.env.RECEIPTS_URL = storeUrl;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});

afterAll(async () => {
  await app.stop();
  delete process.env.RECEIPTS_URL;
  storeServer.closeAllConnections();
  await new Promise(resolve => storeServer.close(resolve));
});

beforeEach(() => {
  stored = [];
  mode = 'keep';
  process.env.RECEIPTS_URL = storeUrl;
});

async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The week in Porto', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  for (const other of others) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
    const invitationId = (invitation.body as { id: string }).id;
    const joined = await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: other.token });
    expect(joined.status).toBe(201);
  }
  return groupId;
}

/** An expense of 87 euros paid by `payer`, split equally between `between`; its id. */
async function expenseOf(groupId: string, payer: { token: string }, between: { id: string }[]): Promise<string> {
  const recorded = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
    body: {
      description: 'Groceries',
      amount: 8700,
      date: SPENT,
      splitBetween: between.map(member => member.id),
    },
    token: payer.token,
  });
  expect(recorded.status).toBe(201);
  return (recorded.body as { id: string }).id;
}

const attach = (expenseId: string, token: string | undefined, bytes: Buffer) =>
  http.request('PUT', `/v1/expenses/${expenseId}/receipt`, {
    raw: bytes,
    headers: { 'content-type': 'application/octet-stream' },
    token,
  });
const readReceipt = (expenseId: string, token?: string) => http.get(`/v1/expenses/${expenseId}/receipt`, { token });
const readExpense = (id: string, token: string) => http.get(`/v1/expenses/${id}`, { token });

describe('Groups → Ledger → the receipts store: a receipt of an expense (request 26)', () => {
  it('keeps a JPEG in the store, and reads its type, its size and the link it is kept at', async () => {
    const ana = await accountOf('ana.receipt.jpeg@example.com', 'Ana');
    const bo = await accountOf('bo.receipt.jpeg@example.com', 'Bo');
    const groupId = await groupWith(ana, [bo]);
    const expenseId = await expenseOf(groupId, ana, [ana, bo]);

    const attached = await attach(expenseId, ana.token, JPEG);
    expect(attached.status).toBe(201);

    expect(stored).toHaveLength(1);
    expect(stored[0].contentType).toBe('image/jpeg');
    expect(stored[0].bytes.equals(JPEG)).toBe(true);

    const read = await readReceipt(expenseId, bo.token);
    expect(read).toMatchObject({
      status: 200,
      body: {
        type: 'image/jpeg',
        size: JPEG.length,
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/files\/1$/),
      },
    });
  });

  it('keeps a PNG, and a receipt of the largest size that is allowed', async () => {
    const ana = await accountOf('ana.receipt.png@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const expenseId = await expenseOf(groupId, ana, [ana]);

    expect((await attach(expenseId, ana.token, PNG)).status).toBe(201);
    expect(await readReceipt(expenseId, ana.token)).toMatchObject({
      status: 200,
      body: { type: 'image/png', size: PNG.length },
    });

    expect((await attach(expenseId, ana.token, LARGEST_JPEG)).status).toBe(201);
    expect(await readReceipt(expenseId, ana.token)).toMatchObject({
      status: 200,
      body: { type: 'image/jpeg', size: 2_097_152 },
    });
  });

  it('replaces the receipt an expense had, and leaves the expense at its version', async () => {
    const ana = await accountOf('ana.receipt.replace@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const expenseId = await expenseOf(groupId, ana, [ana]);
    const before = (await readExpense(expenseId, ana.token)).body as { version: number };

    await attach(expenseId, ana.token, JPEG);
    const first = (await readReceipt(expenseId, ana.token)).body as { url: string };
    await attach(expenseId, ana.token, PNG);

    const replaced = await readReceipt(expenseId, ana.token);
    expect(replaced).toMatchObject({ status: 200, body: { type: 'image/png', size: PNG.length } });
    expect((replaced.body as { url: string }).url).not.toBe(first.url);
    expect(((await readExpense(expenseId, ana.token)).body as { version: number }).version).toBe(before.version);
  });

  it('refuses a file that is not a JPEG or a PNG, an empty one, or a larger one, and sends none of them to the store', async () => {
    const ana = await accountOf('ana.receipt.refused@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const expenseId = await expenseOf(groupId, ana, [ana]);

    for (const bytes of [GIF, Buffer.alloc(0), TOO_LARGE_JPEG]) {
      const refused = await attach(expenseId, ana.token, bytes);
      expect(refused).toMatchObject({ status: 400, body: { type: 'InvalidReceipt' } });
    }
    expect(stored).toHaveLength(0);
    expect(await readReceipt(expenseId, ana.token)).toMatchObject({ status: 404 });
  });

  it('takes the type from the first bytes, never from a header: a body sent as a PNG that is a GIF is refused', async () => {
    const ana = await accountOf('ana.receipt.bytes@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const expenseId = await expenseOf(groupId, ana, [ana]);

    const answer = await http.request('PUT', `/v1/expenses/${expenseId}/receipt`, {
      raw: GIF,
      headers: { 'content-type': 'application/octet-stream' },
      token: ana.token,
    });
    expect(answer).toMatchObject({ status: 400, body: { type: 'InvalidReceipt' } });
    expect(stored).toHaveLength(0);
  });

  it('takes a body only as application/octet-stream: any other content type is refused by the transport, and nothing is sent', async () => {
    const ana = await accountOf('ana.receipt.media@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const expenseId = await expenseOf(groupId, ana, [ana]);

    const answer = await http.request('PUT', `/v1/expenses/${expenseId}/receipt`, {
      raw: PNG,
      headers: { 'content-type': 'image/png' },
      token: ana.token,
    });
    expect(answer.status).toBe(415);
    expect(stored).toHaveLength(0);
  });

  it('lets only the payer or the group’s owner attach a receipt: another member is refused, the owner is not', async () => {
    const ana = await accountOf('ana.receipt.roles@example.com', 'Ana');
    const bo = await accountOf('bo.receipt.roles@example.com', 'Bo');
    const cy = await accountOf('cy.receipt.roles@example.com', 'Cy');
    const groupId = await groupWith(ana, [bo, cy]);
    const expenseId = await expenseOf(groupId, bo, [ana, bo, cy]);

    expect(await attach(expenseId, cy.token, JPEG)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
    expect(stored).toHaveLength(0);

    expect((await attach(expenseId, ana.token, JPEG)).status).toBe(201);
    expect((await attach(expenseId, bo.token, PNG)).status).toBe(201);
  });

  it('answers 404 for an expense that is not there, or to anyone who is not a member of its group', async () => {
    const ana = await accountOf('ana.receipt.strangers@example.com', 'Ana');
    const bo = await accountOf('bo.receipt.strangers@example.com', 'Bo');
    const groupId = await groupWith(ana, []);
    const expenseId = await expenseOf(groupId, ana, [ana]);

    expect(await attach(expenseId, bo.token, JPEG)).toMatchObject({ status: 404 });
    expect(await attach('no-such-expense', ana.token, JPEG)).toMatchObject({ status: 404 });
    expect(await readReceipt(expenseId, bo.token)).toMatchObject({ status: 404 });
    expect(stored).toHaveLength(0);
  });

  it('answers 401 to a caller who is not signed in, for the attachment and for the reading', async () => {
    const ana = await accountOf('ana.receipt.anon@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const expenseId = await expenseOf(groupId, ana, [ana]);

    expect(await attach(expenseId, undefined, JPEG)).toMatchObject({ status: 401 });
    expect(await readReceipt(expenseId)).toMatchObject({ status: 401 });
    expect(stored).toHaveLength(0);
  });

  it('answers 404 when an expense has no receipt to read', async () => {
    const ana = await accountOf('ana.receipt.none@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const expenseId = await expenseOf(groupId, ana, [ana]);

    expect(await readReceipt(expenseId, ana.token)).toMatchObject({ status: 404 });
  });

  it('refuses a receipt the store did not keep, and changes nothing: the one the expense had stays', async () => {
    const ana = await accountOf('ana.receipt.store-fails@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const expenseId = await expenseOf(groupId, ana, [ana]);
    await attach(expenseId, ana.token, JPEG);
    const kept = (await readReceipt(expenseId, ana.token)).body;

    mode = 'fail';
    expect(await attach(expenseId, ana.token, PNG)).toMatchObject({ status: 400, body: { type: 'ReceiptNotKept' } });
    expect(await readReceipt(expenseId, ana.token)).toMatchObject({ status: 200, body: kept });
  });

  it('refuses a receipt when the store does not answer within 5 seconds', async () => {
    const ana = await accountOf('ana.receipt.slow@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const expenseId = await expenseOf(groupId, ana, [ana]);

    mode = 'slow';
    expect(await attach(expenseId, ana.token, JPEG)).toMatchObject({ status: 400, body: { type: 'ReceiptNotKept' } });
    expect(await readReceipt(expenseId, ana.token)).toMatchObject({ status: 404 });
  }, 20000);

  it('refuses a receipt, sending nothing, when no receipts store is configured', async () => {
    const ana = await accountOf('ana.receipt.unset@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const expenseId = await expenseOf(groupId, ana, [ana]);

    delete process.env.RECEIPTS_URL;
    try {
      expect(await attach(expenseId, ana.token, JPEG)).toMatchObject({ status: 400, body: { type: 'ReceiptNotKept' } });
    } finally {
      process.env.RECEIPTS_URL = storeUrl;
    }
    expect(stored).toHaveLength(0);
  });
});
