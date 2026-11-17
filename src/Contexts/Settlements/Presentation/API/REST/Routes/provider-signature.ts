import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The provider signs each webhook: the header `Provider-Signature` is the HMAC-SHA256 of the body exactly as it was sent, with the
 * secret Tally and the provider share, in lowercase hexadecimal (request 13). The proof is checked over the bytes received, before
 * the body is read or decided. A missing header, a missing secret or a different signature is not proof.
 */
export function providerSignatureIsValid(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!rawBody || !signature || !secret) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
