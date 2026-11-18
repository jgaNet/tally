import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { ReceiptStoreOverHttp } from './ReceiptStoreOverHttp';

/**
 * The adapter to the receipts store (request 26): the file goes to `POST /files` with its type, and the link it answers is kept; any other answer,
 * a missing link, a missing store and a store that does not answer in time keep nothing.
 */
let store: Server;
let origin: string;
/** What the fake store answers, and what it received. */
let answer: (request: IncomingMessage, response: ServerResponse) => void;
let received: { contentType?: string; bytes: Buffer }[] = [];

beforeAll(async () => {
  store = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received = [...received, { contentType: request.headers['content-type'], bytes: Buffer.concat(chunks) }];
      answer(request, response);
    });
  });
  await new Promise<void>(resolve => store.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
});
afterAll(async () => {
  store.closeAllConnections();
  await new Promise(resolve => store.close(resolve));
});
beforeEach(() => {
  received = [];
  answer = (_request, response) => {
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'f1', url: `${origin}/files/f1` }));
  };
});

const file = { type: 'image/png' as const, bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) };

describe('the receipts store over HTTP', () => {
  it('sends the file as the body, with its type, and keeps the link the store answers', async () => {
    const adapter = new ReceiptStoreOverHttp(() => origin);
    expect(await adapter.keep(file)).toBe(`${origin}/files/f1`);
    expect(received).toHaveLength(1);
    expect(received[0].contentType).toBe('image/png');
    expect(received[0].bytes.equals(Buffer.from(file.bytes))).toBe(true);
  });

  it('keeps nothing when the store answers anything but 201, or 201 without an id or a link', async () => {
    const adapter = new ReceiptStoreOverHttp(() => origin);
    answer = (_request, response) => response.writeHead(500).end();
    expect(await adapter.keep(file)).toBeUndefined();
    answer = (_request, response) => response.writeHead(200).end(JSON.stringify({ id: 'f1', url: 'x' }));
    expect(await adapter.keep(file)).toBeUndefined();
    answer = (_request, response) => response.writeHead(201).end(JSON.stringify({ url: 'x' }));
    expect(await adapter.keep(file)).toBeUndefined();
    answer = (_request, response) => response.writeHead(201).end(JSON.stringify({ id: 'f1' }));
    expect(await adapter.keep(file)).toBeUndefined();
  });

  it('keeps nothing when the store does not answer in time', async () => {
    const adapter = new ReceiptStoreOverHttp(() => origin, 50);
    answer = () => undefined; // never answers
    expect(await adapter.keep(file)).toBeUndefined();
  });

  it('keeps nothing, and sends nothing, when no store is configured', async () => {
    const adapter = new ReceiptStoreOverHttp(() => undefined);
    expect(await adapter.keep(file)).toBeUndefined();
    expect(received).toHaveLength(0);
  });
});
