/**
 * Whether a webhook was signed by the provider (request 13, docs/adr/0014): the signature is the proof the body came from it, checked
 * over the body as it was sent, before anything is decided. A port, since the key it needs is configuration, not business state.
 */
export interface IWebhookSignature {
  isSignedBy(body: string, signature: string | undefined): boolean;
}
