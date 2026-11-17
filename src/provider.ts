import { createHmac, timingSafeEqual } from 'node:crypto';
import { Refusal } from './refusal';

/**
 * How Tally reaches the payment provider: the base of its API (`PROVIDER_URL`, without a trailing slash),
 * the secret Tally and the provider share to sign webhooks (`PROVIDER_WEBHOOK_SECRET`), and how long the
 * provider may take to answer a payment (5 seconds, unless a test says otherwise). Without a URL, paying
 * through the provider is refused.
 */
export interface ProviderConfig {
  url?: string;
  webhookSecret?: string;
  timeoutMs?: number;
}

/** The provider's answer to a payment: its id, and the link where the payer pays it. */
export interface ProviderPayment {
  id: string;
  payUrl: string;
}

/** A refusal for a payment the provider could not make: the provider did not answer as it should, or in time. */
function providerUnavailable(): Refusal {
  return new Refusal(424, 'ProviderUnavailable', 'The payment provider did not answer a payment.');
}

/** Refuses, with `409`, a payment through the provider on a server that has no `PROVIDER_URL`. */
export function assertProviderConfigured(config: ProviderConfig): asserts config is ProviderConfig & { url: string } {
  if (!config.url) {
    throw new Refusal(
      409,
      'ProviderNotConfigured',
      'Paying through the payment provider is not set up on this server.',
    );
  }
}

/**
 * Asks the provider for a payment of the amount, in the currency, with the settlement's id as its
 * reference, and answers the provider's payment. Only `201` with an `id` and a `payUrl` is an answer: any
 * other answer, or none within the time allowed, is refused.
 */
export async function createProviderPayment(
  config: ProviderConfig & { url: string },
  input: { reference: string; amount: number; currency: string },
): Promise<ProviderPayment> {
  try {
    const response = await fetch(`${config.url}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
    });
    if (response.status !== 201) {
      await response.body?.cancel();
      throw providerUnavailable();
    }
    const answer = (await response.json()) as Partial<ProviderPayment> | null;
    if (
      typeof answer?.id !== 'string' ||
      answer.id === '' ||
      typeof answer.payUrl !== 'string' ||
      answer.payUrl === ''
    ) {
      throw providerUnavailable();
    }
    return { id: answer.id, payUrl: answer.payUrl };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw providerUnavailable();
  }
}

/** The signature of a webhook's body as the provider sends it: HMAC-SHA256 with the secret, in lowercase hexadecimal. */
export function signWebhookBody(secret: string, body: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Whether the signature header is the signature of the body as it was received. With no secret configured,
 * no signature is proven, so every webhook is refused.
 */
export function isValidWebhookSignature(
  secret: string | undefined,
  body: Buffer,
  signature: string | undefined,
): boolean {
  if (!secret || signature === undefined) return false;
  const expected = Buffer.from(signWebhookBody(secret, body), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
