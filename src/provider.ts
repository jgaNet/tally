import { createHmac, timingSafeEqual } from 'node:crypto';
import { Refusal } from './refusal';

/**
 * The payment provider Tally pays through: `url` is the base of its API (without a trailing slash), absent when
 * paying through the provider is not configured; `webhookSecret` is the secret the provider signs webhooks with,
 * shared with Tally; `timeoutMs` is how long the provider has to answer a payment request.
 */
export interface ProviderConfig {
  readonly url: string | undefined;
  readonly webhookSecret: string | undefined;
  readonly timeoutMs: number;
}

/** What the provider answers to a payment request: its id for the payment, and the link where the payer pays. */
export interface ProviderPayment {
  readonly id: string;
  readonly payUrl: string;
}

const UNAVAILABLE = 'The payment provider did not answer with a payment. Nothing was kept.';

/**
 * Asks the provider for a payment of `amount` in `currency`, identified by `reference` (the settlement's id).
 * Answers the provider's payment when it answers `201 { id, payUrl }` within the time limit. Any other answer,
 * an answer that is not that shape, no answer in time, or no provider configured is refused with `424`.
 */
export async function requestPayment(
  provider: ProviderConfig,
  input: { reference: string; amount: number; currency: string },
): Promise<ProviderPayment> {
  if (provider.url === undefined) {
    throw new Refusal(424, 'ProviderNotConfigured', 'Paying through the provider is not configured.');
  }
  let response: Response;
  try {
    response = await fetch(`${provider.url}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(provider.timeoutMs),
    });
    if (response.status !== 201) throw new Error(`answered ${response.status}`);
    // Read inside the try: a body that does not arrive in time is an answer that never came.
    const body: unknown = await response.json();
    if (isPayment(body)) return { id: body.id, payUrl: body.payUrl };
  } catch {
    // Fall through to the refusal: a network error, a timeout, a status other than 201 and a body not shaped
    // as asked all refuse the same way.
  }
  throw new Refusal(424, 'ProviderUnavailable', UNAVAILABLE);
}

function isPayment(value: unknown): value is ProviderPayment {
  if (typeof value !== 'object' || value === null) return false;
  const { id, payUrl } = value as Record<string, unknown>;
  return typeof id === 'string' && id.length > 0 && typeof payUrl === 'string' && payUrl.length > 0;
}

/**
 * True when `signature` is the HMAC-SHA256 of `body`, exactly as sent, with `secret` as the key, in lowercase
 * hexadecimal. With no secret configured nothing is signed by it, so every webhook is refused.
 */
export function isSignedBy(secret: string | undefined, body: Buffer, signature: string | undefined): boolean {
  if (!secret || signature === undefined) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
