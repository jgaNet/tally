import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Whether a webhook's signature is the one the provider makes (ADR 8): the HMAC-SHA256 of the body exactly as sent, with the
 * secret Tally and the provider share as the key, in lowercase hexadecimal, in the `Provider-Signature` header. A missing
 * signature, or no secret at all, is never right.
 */
export function signatureMatches(secret: string, body: string, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
