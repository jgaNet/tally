import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { HttpReceiptStore } from '@Contexts/Ledger/Infrastructure/HttpReceiptStore';
import { ReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

/** A store that answers what it is told to, and records what it was sent. */
let store: Server;
let answer: { status: number; body: string } = {
  status: 201,
  body: '{"id":"file-1","url":"https://receipts.example/file-1"}',
};
let received: { method?: string; path?: string; contentType?: string; bytes: number } | undefined;

beforeAll(async () => {
  store = createServer((req, res) => {
    let size = 0;
    req.on('data', chunk => (size += chunk.length));
    req.on('end', () => {
      received = { method: req.method, path: req.url, contentType: req.headers['content-type'], bytes: size };
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body);
    });
  });
  await new Promise<void>(resolve => store.listen(0, '127.0.0.1', () => resolve()));
});

afterAll(() => store.close());

const base = () => `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
const file = ReceiptFile.read(JPEG).data!;

describe('HttpReceiptStore', () => {
  beforeEach(() => {
    received = undefined;
    answer = { status: 201, body: '{"id":"file-1","url":"https://receipts.example/file-1"}' };
  });

  it('sends the file as its body, with its type, and answers the store’s id and link', async () => {
    const kept = await new HttpReceiptStore(base()).keep(file);
    expect(kept.data).toEqual({ id: 'file-1', url: 'https://receipts.example/file-1' });
    expect(received).toEqual({ method: 'POST', path: '/files', contentType: 'image/jpeg', bytes: JPEG.length });
  });

  it('refuses with ReceiptStoreUnavailable when the store answers anything but 201', async () => {
    answer = { status: 500, body: '' };
    const kept = await new HttpReceiptStore(base()).keep(file);
    expect(kept.error?.type).toBe('ReceiptStoreUnavailable');
  });

  it('refuses a 201 that does not give an id and a link', async () => {
    answer = { status: 201, body: '{"id":"file-1"}' };
    expect((await new HttpReceiptStore(base()).keep(file)).error?.type).toBe('ReceiptStoreUnavailable');
  });

  it('refuses with ReceiptStoreUnavailable when RECEIPTS_URL is not set, and sends nothing', async () => {
    const kept = await new HttpReceiptStore(undefined).keep(file);
    expect(kept.error?.type).toBe('ReceiptStoreUnavailable');
    expect(received).toBeUndefined();
  });
});
