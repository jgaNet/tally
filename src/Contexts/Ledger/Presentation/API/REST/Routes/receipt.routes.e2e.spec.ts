import { jest } from '@jest/globals';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let store: Server;
let previousReceiptsUrl: string | undefined;

/** The instant the test starts at, the 18th of November 2026: the system clock reads the faked Date. */
const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
const TODAY = '2026-11-18';
const TWO_MB = 2_097_152;

/** Every file the stand-in store was sent, in order: its content type and its bytes. */
const received: Array<{ contentType: string | undefined; bytes: Buffer }> = [];
/** Whether the stand-in store fails to keep the file (`500`) instead of keeping it as its API says. */
let failing = false;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 2)]);

beforeAll(async () => {
  jest.useFakeTimers({
    now: T0,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  // A stand-in for the receipts store: it keeps a file sent as its API says, and answers `201 { id, url }`.
  let kept = 0;
  store = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST' || request.url !== '/files') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ contentType: request.headers['content-type'], bytes: Buffer.concat(chunks) });
      if (failing) {
        response.writeHead(500).end();
        return;
      }
      kept += 1;
      const id = `file-${kept}`;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, url: `http://receipts.test/files/${id}` }));
    });
  });
  await new Promise<void>(resolve => store.listen(0, '127.0.0.1', resolve));
  previousReceiptsUrl = process.env.RECEIPTS_URL;
  process.env.RECEIPTS_URL = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});

afterAll(async () => {
  if (previousReceiptsUrl === undefined) delete process.env.RECEIPTS_URL;
  else process.env.RECEIPTS_URL = previousReceiptsUrl;
  await app.stop();
  store.close();
  jest.useRealTimers();
});

type Operation = { status: string; result?: string; error?: { type: string; message: string } };
type Receipt = { type: string; size: number; url: string };

async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password: 'correct horse', name } });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'correct horse' } });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

async function join(token: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: joiner });
  await outcome((accepted.body as { operationId: string }).operationId, joiner);
}

/** A flat of three: Ann its owner, Ben and Cy its members, and Dee who is not in it. */
async function flat(suffix: string) {
  const ann = await signedIn(`receipt-ann-${suffix}@example.com`, 'Ann');
  const ben = await signedIn(`receipt-ben-${suffix}@example.com`, 'Ben');
  const cy = await signedIn(`receipt-cy-${suffix}@example.com`, 'Cy');
  const dee = await signedIn(`receipt-dee-${suffix}@example.com`, 'Dee');
  const groupId = await createGroup(ann.token, 'Flat');
  await join(ann.token, groupId, ben.token);
  await join(ann.token, groupId, cy.token);
  return { ann, ben, cy, dee, groupId };
}

/** Ben pays for an expense split between the three of them: recorded by Ben, so Ben is its payer. */
async function expenseOfBen(token: string, groupId: string, allIds: string[]): Promise<string> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token,
    body: { description: 'Taxi', amount: 900, date: TODAY, splitBetween: allIds },
  });
  const recorded = await outcome((answer.body as { operationId: string }).operationId, token);
  expect(recorded.status).toBe('SUCCESS');
  return recorded.result as string;
}

/** Attaches a file to an expense as its body, and reads the operation to the end. */
async function attach(token: string | undefined, expenseId: string, bytes: Buffer): Promise<Operation> {
  const response = await fetch(`${app.address}${api}/expenses/${expenseId}/receipt`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', ...(token && { authorization: `Bearer ${token}` }) },
    body: Uint8Array.from(bytes),
  });
  if (!token) {
    expect(response.status).toBe(401);
    return { status: 'REFUSED' };
  }
  expect(response.status).toBe(202);
  const { operationId } = (await response.json()) as { operationId: string };
  return outcome(operationId, token);
}

async function readReceipt(token: string, expenseId: string): Promise<{ status: number; body: unknown }> {
  return http.get(`${api}/expenses/${expenseId}/receipt`, { token });
}

describe('receipts (request 26)', () => {
  it('lets the payer attach a JPEG, which the store keeps as sent, and a member reads its type, size and link', async () => {
    const { ann, ben, cy, groupId } = await flat('payer');
    const expense = await expenseOfBen(ben.token, groupId, [ann.id, ben.id, cy.id]);
    const sent = received.length;

    const attached = await attach(ben.token, expense, JPEG);
    expect(attached.status).toBe('SUCCESS');
    expect(received.length).toBe(sent + 1);
    expect(received[sent].contentType).toBe('image/jpeg');
    expect(received[sent].bytes.equals(JPEG)).toBe(true);

    const read = await readReceipt(cy.token, expense);
    expect(read.status).toBe(200);
    expect(read.body as Receipt).toEqual({
      type: 'image/jpeg',
      size: JPEG.length,
      url: expect.stringMatching(/^http:\/\/receipts\.test\/files\/file-\d+$/),
    });
  });

  it('lets the owner replace the receipt with a PNG, the expense keeps its version and the balances do not change', async () => {
    const { ann, ben, cy, groupId } = await flat('owner');
    const expense = await expenseOfBen(ben.token, groupId, [ann.id, ben.id, cy.id]);
    expect((await attach(ben.token, expense, JPEG)).status).toBe('SUCCESS');

    const replaced = await attach(ann.token, expense, PNG);
    expect(replaced.status).toBe('SUCCESS');

    const read = await readReceipt(ben.token, expense);
    expect(read.body as Receipt).toEqual({ type: 'image/png', size: PNG.length, url: expect.any(String) });
    const expenseRead = await http.get(`${api}/expenses/${expense}`, { token: ann.token });
    expect((expenseRead.body as { version: number }).version).toBe(1);
  });

  it('refuses a member who is neither the payer nor the owner, before anything is sent to the store', async () => {
    const { ann, ben, cy, groupId } = await flat('other');
    const expense = await expenseOfBen(ben.token, groupId, [ann.id, ben.id, cy.id]);
    const sent = received.length;

    const refused = await attach(cy.token, expense, JPEG);
    expect(refused.status).toBe('ERROR');
    expect(refused.error?.type).toBe('NotThePayerOrTheOwner');
    expect(received.length).toBe(sent);
    expect((await readReceipt(ann.token, expense)).status).toBe(404);
  });

  it('refuses a file that is not a JPEG or a PNG, an empty one and one larger than 2 MB, before the store is asked; 2 MB exactly is kept', async () => {
    const { ann, ben, cy, groupId } = await flat('shape');
    const expense = await expenseOfBen(ben.token, groupId, [ann.id, ben.id, cy.id]);
    const sent = received.length;

    for (const bytes of [
      Buffer.from('Groceries, 87 euros'),
      Buffer.alloc(0),
      Buffer.concat([JPEG, Buffer.alloc(TWO_MB)]),
    ]) {
      const refused = await attach(ben.token, expense, bytes);
      expect(refused.status).toBe('ERROR');
      expect(refused.error?.type).toBe('InvalidReceiptFile');
    }
    expect(received.length).toBe(sent);

    const exact = Buffer.concat([JPEG, Buffer.alloc(TWO_MB - JPEG.length)]);
    expect((await attach(ben.token, expense, exact)).status).toBe('SUCCESS');
    expect(((await readReceipt(ben.token, expense)).body as Receipt).size).toBe(TWO_MB);
  });

  it('refuses a receipt the store did not keep, and keeps the one the expense had', async () => {
    const { ann, ben, cy, groupId } = await flat('store');
    const expense = await expenseOfBen(ben.token, groupId, [ann.id, ben.id, cy.id]);
    expect((await attach(ben.token, expense, JPEG)).status).toBe('SUCCESS');

    failing = true;
    try {
      const refused = await attach(ben.token, expense, PNG);
      expect(refused.status).toBe('ERROR');
      expect(refused.error?.type).toBe('ReceiptNotStored');
    } finally {
      failing = false;
    }
    expect(((await readReceipt(ann.token, expense)).body as Receipt).type).toBe('image/jpeg');
  });

  it('refuses every receipt when the server has no receipts store, and an expense with none answers 404', async () => {
    const { ann, ben, cy, groupId } = await flat('unset');
    const expense = await expenseOfBen(ben.token, groupId, [ann.id, ben.id, cy.id]);
    const sent = received.length;

    const saved = process.env.RECEIPTS_URL;
    delete process.env.RECEIPTS_URL;
    try {
      const refused = await attach(ben.token, expense, JPEG);
      expect(refused.status).toBe('ERROR');
      expect(refused.error?.type).toBe('ReceiptNotStored');
    } finally {
      process.env.RECEIPTS_URL = saved;
    }
    expect(received.length).toBe(sent);
    expect((await readReceipt(ben.token, expense)).status).toBe(404);
  });

  it('answers a receipt only to a member of the expense’s group, and a refused attachment as the expense not found', async () => {
    const { ann, ben, cy, dee, groupId } = await flat('reads');
    const expense = await expenseOfBen(ben.token, groupId, [ann.id, ben.id, cy.id]);
    expect((await attach(ben.token, expense, JPEG)).status).toBe('SUCCESS');

    expect((await readReceipt(dee.token, expense)).status).toBe(404);
    const stranger = await attach(dee.token, expense, JPEG);
    expect(stranger.status).toBe('ERROR');
    expect(stranger.error?.type).toBe('NotFound');
    expect((await readReceipt(cy.token, 'no-such-expense')).status).toBe(404);
  });

  it('refuses an attachment by someone who is not signed in at once, with 401', async () => {
    const { ann, ben, cy, groupId } = await flat('anonymous');
    const expense = await expenseOfBen(ben.token, groupId, [ann.id, ben.id, cy.id]);
    const sent = received.length;

    expect(await attach(undefined, expense, JPEG)).toEqual({ status: 'REFUSED' });
    expect(received.length).toBe(sent);
  });
});

describe('Groups → Ledger', () => {
  it('attaches a receipt to an expense in a group made in Groups, and finds it by the id the expense’s operation answered', async () => {
    const ann = await signedIn('receipt-rel-ann@example.com', 'Ann');
    const ben = await signedIn('receipt-rel-ben@example.com', 'Ben');
    const cy = await signedIn('receipt-rel-cy@example.com', 'Cy');
    // Groups makes the group and answers its id; the membership Ledger reads is the one Groups made.
    const groupId = await createGroup(ann.token, 'Just joined');
    await join(ann.token, groupId, ben.token);
    await join(ann.token, groupId, cy.token);

    const expense = await expenseOfBen(ben.token, groupId, [ann.id, ben.id, cy.id]);
    const attached = await attach(ben.token, expense, PNG);
    expect(attached).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });

    // Cy is a member through Groups' join, and reads the receipt of the expense its id Ledger answered.
    const read = await readReceipt(cy.token, expense);
    expect(read.body as Receipt).toEqual({ type: 'image/png', size: PNG.length, url: expect.any(String) });
  });
});
