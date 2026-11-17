import { createHmac, timingSafeEqual } from 'node:crypto';

import { IWebhookSignature } from '@Contexts/Settlements/Application/IWebhookSignature';

/**
 * The provider's signature of a webhook (feature 13): the HMAC-SHA256 of the body exactly as it was sent, with the secret the provider
 * and Tally share as the key, in lowercase hexadecimal. The comparison is constant-time. With no secret configured, no webhook is the
 * provider's, so every webhook is refused.
 */
export class HmacWebhookSignature implements IWebhookSignature {
  constructor(private readonly secret: string | undefined) {}

  isSignedByProvider(body: string, signature: string | undefined): boolean {
    if (!this.secret || !signature) return false;
    const expected = Buffer.from(createHmac('sha256', this.secret).update(body, 'utf8').digest('hex'), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
