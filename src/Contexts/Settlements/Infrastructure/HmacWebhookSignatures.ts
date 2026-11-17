import { createHmac, timingSafeEqual } from 'crypto';

import { IWebhookSignatures } from '@Contexts/Settlements/Application/Ports/IWebhookSignatures';

/**
 * The provider's signature: the HMAC-SHA256 of the body exactly as it was sent, keyed with the secret Tally and the provider share,
 * in lowercase hexadecimal (`Provider-Signature`). With no secret configured, nothing is signed.
 */
export class HmacWebhookSignatures implements IWebhookSignatures {
  constructor(private secret: () => string | undefined = () => process.env.PROVIDER_WEBHOOK_SECRET) {}

  isSigned(rawBody: string, signature: string | undefined): boolean {
    const key = this.secret();
    if (!key || !signature) return false;
    const expected = Buffer.from(createHmac('sha256', key).update(rawBody).digest('hex'), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
