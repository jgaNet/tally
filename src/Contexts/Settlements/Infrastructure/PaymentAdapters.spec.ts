import { createHmac } from 'crypto';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

import { HmacWebhookSignature } from '@Contexts/Settlements/Infrastructure/HmacWebhookSignature';
import { HttpPaymentProvider, PROVIDER_TIMEOUT_MS } from '@Contexts/Settlements/Infrastructure/HttpPaymentProvider';

const REQUEST = { reference: 'settlement-1', amount: 30, currency: 'EUR' };

/** A provider's server that answers each request with what `answer` says, or never answers when it says nothing. */
async function providerAt(answer: (path: string) => { status: number; body: string } | undefined) {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      requests.push({ url: request.url ?? '', method: request.method ?? '', body });
      const reply = answer(request.url ?? '');
      if (reply) response.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe('the payment provider over HTTP', () => {
  it('asks POST /payments for the reference, amount and currency, and takes the link it answers 201 with', async () => {
    const provider = await providerAt(() => ({
      status: 201,
      body: '{"id":"pay-1","payUrl":"https://pay.example/pay-1"}',
    }));
    try {
      const link = await new HttpPaymentProvider(() => `${provider.origin}/`).requestPayment(REQUEST);
      expect(link.isSuccess() && link.data).toEqual({ id: 'pay-1', payUrl: 'https://pay.example/pay-1' });
      expect(provider.requests).toEqual([{ url: '/payments', method: 'POST', body: JSON.stringify(REQUEST) }]);
    } finally {
      await provider.close();
    }
  });

  it('refuses any other answer, or a body that is not a link, as ProviderUnavailable', async () => {
    const other = await providerAt(() => ({
      status: 200,
      body: '{"id":"pay-1","payUrl":"https://pay.example/pay-1"}',
    }));
    const broken = await providerAt(() => ({ status: 201, body: '{"id":"pay-1"}' }));
    try {
      const adapter = (origin: string) => new HttpPaymentProvider(() => origin);
      for (const origin of [other.origin, broken.origin]) {
        const refused = await adapter(origin).requestPayment(REQUEST);
        expect(refused.isFailure() && refused.error.type).toBe('ProviderUnavailable');
      }
    } finally {
      await other.close();
      await broken.close();
    }
  });

  it('refuses a provider that does not answer in time, and an unconfigured one, as ProviderUnavailable', async () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(5000);
    const silent = await providerAt(() => undefined);
    try {
      const late = await new HttpPaymentProvider(() => silent.origin, 50).requestPayment(REQUEST);
      expect(late.isFailure() && late.error.type).toBe('ProviderUnavailable');
      const unset = await new HttpPaymentProvider(() => undefined).requestPayment(REQUEST);
      expect(unset.isFailure() && unset.error.type).toBe('ProviderUnavailable');
    } finally {
      await silent.close();
    }
  });
});

describe('the signature of a webhook', () => {
  const body = '{"id":"w-1","paymentId":"pay-1","status":"succeeded","at":"2026-11-17T10:00:00Z"}';
  const secret = 'a-shared-secret';
  const signed = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts the HMAC-SHA256 of the body as sent, in lowercase hexadecimal, with the shared secret', () => {
    expect(new HmacWebhookSignature(() => secret).isSignedBy(body, signed)).toBe(true);
  });

  it('refuses a missing signature, a wrong one, an uppercase one, one over another body, and no secret', () => {
    const verifier = new HmacWebhookSignature(() => secret);
    expect(verifier.isSignedBy(body, undefined)).toBe(false);
    expect(verifier.isSignedBy(body, 'deadbeef')).toBe(false);
    expect(verifier.isSignedBy(body, signed.toUpperCase())).toBe(false);
    expect(verifier.isSignedBy(`${body} `, signed)).toBe(false);
    expect(new HmacWebhookSignature(() => undefined).isSignedBy(body, signed)).toBe(false);
  });
});
