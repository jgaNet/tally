import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 26 over HTTP: a receipt attached by the payer or the owner, a JPEG or a PNG of at most 2 MB, kept in the receipts store `RECEIPTS_URL`
 * names, and read back by a member. The store is a fake one, on a port of its own; `RECEIPTS_URL` is read at each request, so a test can take it
 * away. Every answer is held to the API `api/` gives, through `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

/** A fake receipts store: `POST /files` keeps the bytes and answers `201 { id, url }`, unless the test says it answers otherwise. */
let store: Server;
let storeOrigin: string;
let storeMode: 'ok' | 'down' | 'no-link' | 'hang' = 'ok';
/** The files it was sent, in order, each with the type it was sent as. */
let kept: { contentType: string | undefined; bytes: Buffer }[] = [];

beforeAll(async () => {
  store = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      if (storeMode === 'hang') return; // never answers: Tally gives up after 5 seconds
      if (storeMode === 'down') {
        response.writeHead(500).end();
        return;
      }
      kept = [...kept, { contentType: request.headers['content-type'], bytes: Buffer.concat(chunks) }];
      const id = `file-${kept.length}`;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify(storeMode === 'no-link' ? { id } : { id, url: `${storeOrigin}/files/${id}` }));
    });
  });
  await new Promise<void>(resolve => store.listen(0, '127.0.0.1', () => resolve()));
  storeOrigin = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;

  process.env.DATABASE_URL = await freshDatabaseUrl();
  process.env.RECEIPTS_URL = storeOrigin;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  store.closeAllConnections();
  await new Promise(resolve => store.close(resolve));
});
beforeEach(() => {
  process.env.RECEIPTS_URL = storeOrigin;
  storeMode = 'ok';
  kept = [];
});

let accountCount = 0;
async function signedInPerson(name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  return { token, id: (created.body as { id: string }).id };
}

/** A EUR group owned by `owner`, which each of `others` has joined through an invitation. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const { id } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: owner.token })
  ).body as { id: string };
  for (const person of others) {
    const invitation = (await http.request('POST', `${api}/groups/${id}/invitations`, { token: owner.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return id;
}

const record = (groupId: string, body: Record<string, unknown>, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const getExpense = (id: string, token?: string) => http.request('GET', `${api}/expenses/${id}`, { token });
const attach = (id: string, bytes: Uint8Array, token?: string) =>
  http.request('PUT', `${api}/expenses/${id}/receipt`, {
    body: bytes,
    token,
    headers: { 'content-type': 'application/octet-stream' },
  });
const getReceipt = (id: string, token?: string) => http.request('GET', `${api}/expenses/${id}/receipt`, { token });

/** A file of `size` bytes that starts as a JPEG does, or as a PNG does. */
const jpeg = (size = 64): Uint8Array => fileStarting([0xff, 0xd8, 0xff, 0xe0], size);
const png = (size = 64): Uint8Array => fileStarting([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], size);
function fileStarting(start: number[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(start);
  return bytes;
}

/** Ada and Bo share a group; Ada records an expense she paid, split between the two of them. */
async function sharedExpense(): Promise<{
  ada: { token: string; id: string };
  bo: { token: string; id: string };
  expenseId: string;
  groupId: string;
}> {
  const ada = await signedInPerson('Ada');
  const bo = await signedInPerson('Bo');
  const groupId = await groupWith(ada, [bo]);
  const { id } = (
    await record(
      groupId,
      { description: 'Groceries', date: '2026-11-10', amount: 8700, splitBetween: [ada.id, bo.id] },
      ada.token,
    )
  ).body as { id: string };
  return { ada, bo, expenseId: id, groupId };
}

describe('attaching a receipt', () => {
  it('lets the payer attach a JPEG, which the store keeps, and a member reads its type, size and link', async () => {
    const { ada, bo, expenseId } = await sharedExpense();
    const bytes = jpeg(1000);

    const attached = await attach(expenseId, bytes, ada.token);
    expect(attached.status).toBe(204);
    expect(kept).toHaveLength(1);
    expect(kept[0].contentType).toBe('image/jpeg');
    expect(kept[0].bytes.equals(Buffer.from(bytes))).toBe(true);

    const read = await getReceipt(expenseId, bo.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ type: 'image/jpeg', size: 1000, url: `${storeOrigin}/files/file-1` });
  });

  it('keeps a PNG as a PNG', async () => {
    const { ada, expenseId } = await sharedExpense();
    expect((await attach(expenseId, png(300), ada.token)).status).toBe(204);
    expect((await getReceipt(expenseId, ada.token)).body).toEqual({
      type: 'image/png',
      size: 300,
      url: `${storeOrigin}/files/file-1`,
    });
  });

  it('is not an edit: the expense keeps its version', async () => {
    const { ada, expenseId } = await sharedExpense();
    expect((await getExpense(expenseId, ada.token)).body).toMatchObject({ version: 1 });
    expect((await attach(expenseId, jpeg(), ada.token)).status).toBe(204);
    expect((await getExpense(expenseId, ada.token)).body).toMatchObject({ version: 1 });
  });

  it('lets the owner attach a receipt to an expense another member paid', async () => {
    const ada = await signedInPerson('Ada');
    const bo = await signedInPerson('Bo');
    const groupId = await groupWith(ada, [bo]);
    const { id } = (
      await record(
        groupId,
        { description: 'Rent', date: '2026-11-01', amount: 900, splitBetween: [ada.id, bo.id] },
        bo.token,
      )
    ).body as { id: string };

    expect((await attach(id, png(), ada.token)).status).toBe(204);
    expect((await getReceipt(id, bo.token)).status).toBe(200);
  });

  it('replaces the receipt the expense had, and keeps the one it had when the store does not keep the new one', async () => {
    const { ada, expenseId } = await sharedExpense();
    await attach(expenseId, jpeg(), ada.token);
    await attach(expenseId, png(500), ada.token);
    expect((await getReceipt(expenseId, ada.token)).body).toEqual({
      type: 'image/png',
      size: 500,
      url: `${storeOrigin}/files/file-2`,
    });

    storeMode = 'down';
    expect((await attach(expenseId, jpeg(), ada.token)).status).toBe(400);
    expect((await getReceipt(expenseId, ada.token)).body).toEqual({
      type: 'image/png',
      size: 500,
      url: `${storeOrigin}/files/file-2`,
    });
  });

  it('accepts a file of exactly 2 MB and refuses one byte more, which nothing is sent for', async () => {
    const { ada, expenseId } = await sharedExpense();
    expect((await attach(expenseId, jpeg(2_097_152), ada.token)).status).toBe(204);
    expect((await getReceipt(expenseId, ada.token)).body).toMatchObject({ size: 2_097_152 });

    const sent = kept.length;
    const refused = await attach(expenseId, jpeg(2_097_153), ada.token);
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ type: 'InvalidReceipt', message: expect.any(String) });
    expect(kept).toHaveLength(sent);
  });

  it('refuses an empty file, and one that is neither a JPEG nor a PNG, before anything is sent', async () => {
    const { ada, expenseId } = await sharedExpense();
    expect((await attach(expenseId, new Uint8Array(0), ada.token)).status).toBe(400);
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
    expect((await attach(expenseId, gif, ada.token)).status).toBe(400);
    expect(kept).toHaveLength(0);
    expect((await getReceipt(expenseId, ada.token)).status).toBe(404);
  });

  it('refuses a member who is neither the payer nor the owner', async () => {
    const { ada, bo, expenseId } = await sharedExpense();
    const answer = await attach(expenseId, jpeg(), bo.token);
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ type: 'NotAllowed', message: expect.any(String) });
    expect(kept).toHaveLength(0);
    expect((await getReceipt(expenseId, ada.token)).status).toBe(404);
  });

  it('gives the answer for an expense that does not exist to anyone who is not a member', async () => {
    const { expenseId } = await sharedExpense();
    const cy = await signedInPerson('Cy');
    expect((await attach(expenseId, jpeg(), cy.token)).status).toBe(404);
    expect((await getReceipt(expenseId, cy.token)).status).toBe(404);
    expect(kept).toHaveLength(0);
  });

  it('refuses a caller who is not signed in, at once', async () => {
    const { expenseId } = await sharedExpense();
    expect((await attach(expenseId, jpeg())).status).toBe(401);
    expect(kept).toHaveLength(0);
  });

  it('refuses the receipt when the store answers without a link, and nothing changes', async () => {
    const { ada, expenseId } = await sharedExpense();
    storeMode = 'no-link';
    expect((await attach(expenseId, jpeg(), ada.token)).status).toBe(400);
    expect((await getReceipt(expenseId, ada.token)).status).toBe(404);
  });

  it('refuses the receipt when no store is configured, and sends nothing', async () => {
    const { ada, expenseId } = await sharedExpense();
    delete process.env.RECEIPTS_URL;
    try {
      expect((await attach(expenseId, jpeg(), ada.token)).status).toBe(400);
    } finally {
      process.env.RECEIPTS_URL = storeOrigin;
    }
    expect(kept).toHaveLength(0);
  });

  it('refuses the receipt when the store does not answer within 5 seconds', async () => {
    const { ada, expenseId } = await sharedExpense();
    storeMode = 'hang';
    expect((await attach(expenseId, jpeg(), ada.token)).status).toBe(400);
    expect((await getReceipt(expenseId, ada.token)).status).toBe(404);
  }, 20_000);
});

describe('reading a receipt', () => {
  it('answers 404 for an expense that has no receipt', async () => {
    const { ada, expenseId } = await sharedExpense();
    expect((await getReceipt(expenseId, ada.token)).status).toBe(404);
  });

  it('refuses a caller who is not signed in', async () => {
    const { expenseId } = await sharedExpense();
    expect((await getReceipt(expenseId)).status).toBe(401);
  });
});
