import { createHmac } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { HmacWebhookSignature } from '@Contexts/Settlements/Infrastructure/HmacWebhookSignature';

const SECRET = 'a secret Tally and the provider share';
const BODY = '{"id":"wh-1","paymentId":"pay-1","status":"succeeded","at":"2026-03-01T10:00:00.000Z"}';

/** The provider's signature, as the provider makes it: HMAC-SHA256 of the body as sent, lowercase hexadecimal. */
const signed = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');

describe('the signature of the provider over a webhook', () => {
  const signatures = new HmacWebhookSignature(SECRET);

  it('is the provider when it is the HMAC of the body as sent, with the shared secret', () => {
    expect(signatures.isSignedByProvider(BODY, signed(BODY))).toBe(true);
  });

  it('is not the provider when it is missing, wrong, or made with another secret or over another body', () => {
    expect(signatures.isSignedByProvider(BODY, undefined)).toBe(false);
    expect(signatures.isSignedByProvider(BODY, '')).toBe(false);
    expect(signatures.isSignedByProvider(BODY, 'deadbeef')).toBe(false);
    expect(signatures.isSignedByProvider(BODY, signed(BODY, 'another secret'))).toBe(false);
    expect(signatures.isSignedByProvider(BODY.replace('succeeded', 'failed'), signed(BODY))).toBe(false);
    expect(signatures.isSignedByProvider(BODY, signed(BODY).toUpperCase())).toBe(false);
  });

  it('refuses every webhook when no secret is configured', () => {
    expect(new HmacWebhookSignature(undefined).isSignedByProvider(BODY, signed(BODY))).toBe(false);
  });
});
