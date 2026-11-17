import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

import { HttpOfferedRates } from '@Contexts/Ledger/Infrastructure/HttpOfferedRates';

const REQUEST = { from: 'CHF', to: 'EUR', date: '2026-01-15' };

/** A rates service that answers each request with what `answer` says, or never answers when it says nothing. */
async function ratesAt(answer: (path: string) => { status: number; body: string } | undefined) {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const reply = answer(request.url ?? '');
    if (reply) response.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe('the rates service over HTTP (request 22)', () => {
  it('asks GET /rates/{from}/{to} for the day, and takes the rate it answers 200 with, as the string given', async () => {
    const service = await ratesAt(() => ({ status: 200, body: '{"rate":"0.95"}' }));
    try {
      const offer = await new HttpOfferedRates(() => `${service.origin}/`).offeredRate(REQUEST);
      expect(offer).toEqual({ kind: 'offered', rate: '0.95' });
      expect(service.requests).toEqual(['/rates/CHF/EUR?date=2026-01-15']);
    } finally {
      await service.close();
    }
  });

  it('answers no rate for a 404, and for every answer that is not a rate: a number, a zero, too many digits, a missing field, bad JSON', async () => {
    const bodies = ['{"rate":0.95}', '{"rate":"0"}', '{"rate":"0.0000001"}', '{"rate":"-1"}', '{}', '{"rate":', ''];
    for (const body of bodies) {
      const service = await ratesAt(() => ({ status: 200, body }));
      try {
        expect(await new HttpOfferedRates(() => service.origin).offeredRate(REQUEST)).toEqual({ kind: 'none' });
      } finally {
        await service.close();
      }
    }
    const missing = await ratesAt(() => ({ status: 404, body: '' }));
    const failed = await ratesAt(() => ({ status: 500, body: '{"rate":"0.95"}' }));
    try {
      expect(await new HttpOfferedRates(() => missing.origin).offeredRate(REQUEST)).toEqual({ kind: 'none' });
      expect(await new HttpOfferedRates(() => failed.origin).offeredRate(REQUEST)).toEqual({ kind: 'none' });
    } finally {
      await missing.close();
      await failed.close();
    }
  });

  it('answers no rate when the service does not answer in time, or cannot be reached', async () => {
    const silent = await ratesAt(() => undefined);
    try {
      expect(await new HttpOfferedRates(() => silent.origin, 50).offeredRate(REQUEST)).toEqual({ kind: 'none' });
    } finally {
      await silent.close();
    }
    // A closed port: nothing listens there any more.
    const gone = await ratesAt(() => undefined);
    const closedOrigin = gone.origin;
    await gone.close();
    expect(await new HttpOfferedRates(() => closedOrigin).offeredRate(REQUEST)).toEqual({ kind: 'none' });
  });

  it('answers unavailable when no rates service is configured, and reads the base at each call', async () => {
    expect(await new HttpOfferedRates(() => undefined).offeredRate(REQUEST)).toEqual({ kind: 'unavailable' });
    expect(await new HttpOfferedRates(() => '').offeredRate(REQUEST)).toEqual({ kind: 'unavailable' });
  });
});
