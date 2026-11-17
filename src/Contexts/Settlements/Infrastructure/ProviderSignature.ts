import { createHmac, timingSafeEqual } from 'crypto';

/** The signature of a webhook's body as the provider makes it: HMAC-SHA256 of the body exactly as sent, keyed with the shared secret, in lowercase hexadecimal. */
export function signatureOf(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Whether a webhook is signed by the provider (request 13): the `Provider-Signature` header is present and is the signature of the body
 * as received, under the secret Tally and the provider share. Without a secret, nothing is signed; a missing or wrong signature is refused.
 */
export function isSignedByProvider(body: Buffer, header: string | undefined, secret: string | undefined): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(signatureOf(body, secret));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
