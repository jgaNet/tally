import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';

import { HttpReceiptStore } from '@Contexts/Ledger/Infrastructure/HttpReceiptStore';

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

/** A receipts store that answers each request with what `answer` says, or never answers when it says nothing. */
async function storeAt(answer: (request: IncomingMessage) => { status: number; body: string } | undefined) {
  const requests: Array<{ method?: string; url?: string; contentType?: string; bytes: Buffer }> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        bytes: Buffer.concat(chunks),
      });
      const reply = answer(request);
      if (reply) response.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe('the receipts store over HTTP (request 26)', () => {
  it('posts the file as the body, with its type, and takes the link it answers 201 with', async () => {
    const store = await storeAt(() => ({ status: 201, body: '{"id":"f-1","url":"https://receipts.example/f-1"}' }));
    try {
      const kept = await new HttpReceiptStore(() => `${store.origin}/`).keep({ bytes: BYTES, type: 'image/jpeg' });
      expect(kept.data).toBe('https://receipts.example/f-1');
      expect(store.requests).toHaveLength(1);
      expect(store.requests[0]).toMatchObject({ method: 'POST', url: '/files', contentType: 'image/jpeg' });
      expect(store.requests[0].bytes.equals(Buffer.from(BYTES))).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('refuses when the store answers anything but 201, a body that is not an id and a link, or cannot be reached', async () => {
    const bodies = [
      '{"id":"f-1"}',
      '{"url":"https://receipts.example/f-1"}',
      '{"id":"","url":"x"}',
      '{"id":"f-1","url":""}',
      'nope',
    ];
    for (const body of bodies) {
      const store = await storeAt(() => ({ status: 201, body }));
      try {
        expect(
          (await new HttpReceiptStore(() => store.origin).keep({ bytes: BYTES, type: 'image/png' })).error,
        ).toMatchObject({
          type: 'ReceiptStoreUnavailable',
        });
      } finally {
        await store.close();
      }
    }
    const failed = await storeAt(() => ({ status: 500, body: '{"id":"f-1","url":"x"}' }));
    try {
      expect(
        (await new HttpReceiptStore(() => failed.origin).keep({ bytes: BYTES, type: 'image/png' })).error,
      ).toMatchObject({
        type: 'ReceiptStoreUnavailable',
      });
    } finally {
      await failed.close();
    }
    expect(
      (await new HttpReceiptStore(() => 'http://127.0.0.1:9').keep({ bytes: BYTES, type: 'image/png' })).isFailure(),
    ).toBe(true);
    expect((await new HttpReceiptStore(() => undefined).keep({ bytes: BYTES, type: 'image/png' })).isFailure()).toBe(
      true,
    );
  });

  it('refuses when the store does not answer in time, and keeps nothing', async () => {
    const silent = await storeAt(() => undefined);
    try {
      const kept = await new HttpReceiptStore(() => silent.origin, 50).keep({ bytes: BYTES, type: 'image/jpeg' });
      expect(kept.error).toMatchObject({ type: 'ReceiptStoreUnavailable' });
    } finally {
      await silent.close();
    }
  });
});
