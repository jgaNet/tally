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

/**
 * The provider's answer to a payment: its id, the link where the payer pays it, and its fee: what the provider keeps out of
 * what it pays the payee, in hundredths of the payment's currency.
 */
export interface ProviderPayment {
  id: string;
  payUrl: string;
  fee: number;
}

/**
 * A refusal for a request the provider could not answer: it did not answer as it should, or in time. `about` says
 * what was asked of it.
 */
export function providerUnavailable(about = 'a payment'): Refusal {
  return new Refusal(424, 'ProviderUnavailable', `The payment provider did not answer ${about}.`);
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
 * Asks the provider for a payment of the amount, in the currency, to the payee's payout account, with the
 * settlement's id as its reference, and answers the provider's payment. Only `201` with an `id`, a `payUrl` and a `fee` is
 * an answer: any other answer, or none within the time allowed, is refused. The fee is a whole number, 0 or more, and less
 * than the amount: one that is not is no answer either.
 */
export async function createProviderPayment(
  config: ProviderConfig & { url: string },
  input: { reference: string; amount: number; currency: string; payee: string },
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
      answer.payUrl === '' ||
      !Number.isInteger(answer.fee) ||
      (answer.fee as number) < 0 ||
      (answer.fee as number) >= input.amount
    ) {
      throw providerUnavailable();
    }
    return { id: answer.id, payUrl: answer.payUrl, fee: answer.fee as number };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw providerUnavailable();
  }
}

/**
 * Asks the provider whether it knows the account `accountId`: `200` with that `id` means it does, `404` means it
 * does not. Any other answer, or none within the time allowed, is refused.
 */
export async function isKnownProviderAccount(
  config: ProviderConfig & { url: string },
  accountId: string,
): Promise<boolean> {
  const about = 'the payout account';
  try {
    const response = await fetch(`${config.url}/accounts/${encodeURIComponent(accountId)}`, {
      signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return false;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw providerUnavailable(about);
    }
    const answer = (await response.json()) as { id?: unknown } | null;
    if (answer?.id !== accountId) throw providerUnavailable(about);
    return true;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw providerUnavailable(about);
  }
}

/**
 * Asks the provider to refund the payment `paymentId`, with the settlement's id as the `reference`. Only `201`
 * with an `id` is an answer: any other answer, or none within the time allowed, is refused.
 */
export async function refundProviderPayment(
  config: ProviderConfig & { url: string },
  input: { paymentId: string; reference: string },
): Promise<void> {
  try {
    const response = await fetch(`${config.url}/payments/${encodeURIComponent(input.paymentId)}/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference: input.reference }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
    });
    if (response.status !== 201) {
      await response.body?.cancel();
      throw providerUnavailable();
    }
    const answer = (await response.json()) as { id?: unknown } | null;
    if (typeof answer?.id !== 'string' || answer.id === '') throw providerUnavailable();
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
