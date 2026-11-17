/**
 * Whether a webhook of the payment provider is the provider's, as the provider signed it (feature 13): a port Settlements owns, named for
 * what it decides. `isSignedByProvider` answers whether `signature` is the provider's signature of `body`, the request's body exactly as it
 * was sent; a missing signature is not the provider's. The signature is the proof of who sent the webhook, so nothing else about it is
 * trusted. The adapter holds the secret the provider and Tally share.
 */
export interface IWebhookSignature {
  isSignedByProvider(body: string, signature: string | undefined): boolean;
}
