/**
 * Whether a webhook is signed by the provider: the signature is the proof a webhook is the provider's, checked over the body as it
 * was sent, before anything is decided. A missing signature, or one that does not match, is not signed.
 */
export interface IWebhookSignatures {
  isSigned(rawBody: string, signature: string | undefined): boolean;
}
