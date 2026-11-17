import { createHmac, timingSafeEqual } from 'crypto';

import { IWebhookSignature } from '@Contexts/Settlements/Application/Ports/IWebhookSignature';

/**
 * The provider's signature over HTTP (request 13, docs/adr/0014): the header `Provider-Signature` is the HMAC-SHA256 of the body, exactly as
 * sent, with the shared secret `PROVIDER_WEBHOOK_SECRET` as the key, in lowercase hexadecimal. The secret is read at each check; with none
 * set, nothing is signed, and every webhook is refused.
 */
export class HmacWebhookSignature implements IWebhookSignature {
  constructor(private readonly secret: () => string | undefined = () => process.env.PROVIDER_WEBHOOK_SECRET) {}

  isSignedBy(body: string, signature: string | undefined): boolean {
    const secret = this.secret();
    if (!secret || !signature) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(body, 'utf8').digest('hex'), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
