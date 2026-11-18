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

/**
 * What the provider answers to a payment request: its id for the payment, the link where the payer pays, and the fee
 * it keeps out of what it pays the payee, in the minor unit of the payment's currency.
 */
export interface ProviderPayment {
  readonly id: string;
  readonly payUrl: string;
  readonly fee: number;
}

/** What the provider answers to a refund request: its id for the refund. */
export interface ProviderRefund {
  readonly id: string;
}

const UNAVAILABLE = 'The payment provider did not answer with a payment. Nothing was kept.';
const REFUND_UNAVAILABLE = 'The payment provider did not answer with a refund. Nothing was kept.';
const ACCOUNT_UNAVAILABLE = 'The payment provider did not answer whether it knows the account. Nothing was kept.';

/** What the provider answered: its status, and its body when the body is JSON. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The provider's answer to a request of `init` to `path` of its API at `url`, within `timeoutMs`. The body is read
 * inside the time limit: a body that does not arrive in time is an answer that never came, so this answers
 * `undefined`, as does a request that gets no answer at all. The caller decides the refusal.
 */
async function answerTo(url: string, timeoutMs: number, path: string, init: RequestInit): Promise<Answer | undefined> {
  try {
    const response = await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    return { status: response.status, body: parseJson(text) };
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The body of the provider's `201` answer to `body` posted to `path` of its API at `url`, within `timeoutMs`.
 * Any other answer, a body that does not arrive in time, and no answer at all give `undefined`: they refuse the
 * same way, so the caller decides the refusal.
 */
async function createdAt(url: string, timeoutMs: number, path: string, body: unknown): Promise<unknown> {
  const answer = await answerTo(url, timeoutMs, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return answer?.status === 201 ? answer.body : undefined;
}

/**
 * Asks the provider for a payment of `amount` in `currency` to `payee` (the provider's id of the payee's payout
 * account), identified by `reference` (the settlement's id). Answers the provider's payment when it answers
 * `201 { id, payUrl, fee }` within the time limit, where `fee` is a whole number, 0 or more, and less than `amount`: the
 * fee the provider keeps out of the payment. Any other answer, an answer that is not that shape, a fee that is missing or
 * not less than `amount`, no answer in time, or no provider configured is refused with `424`, and nothing is kept.
 */
export async function requestPayment(
  provider: ProviderConfig,
  input: { reference: string; amount: number; currency: string; payee: string },
): Promise<ProviderPayment> {
  if (provider.url === undefined) {
    throw new Refusal(424, 'ProviderNotConfigured', 'Paying through the provider is not configured.');
  }
  const body = await createdAt(provider.url, provider.timeoutMs, '/payments', input);
  if (isPayment(body) && body.fee < input.amount) {
    return { id: body.id, payUrl: body.payUrl, fee: body.fee };
  }
  // Every other answer refuses the same way, nothing kept.
  throw new Refusal(424, 'ProviderUnavailable', UNAVAILABLE);
}

/**
 * Asks the provider whether it knows the account `accountId` (the provider's id of an account) as a payee. It knows
 * it when it answers `200 { id }` with that id within the time limit; `404` refuses it as unknown (`422`). Any other
 * answer, and no answer in time, is refused with `424`, as {@link requestPayment} refuses a payment, and so is no
 * provider configured. It changes nothing at the provider.
 */
export async function requireKnownAccount(provider: ProviderConfig, accountId: string): Promise<void> {
  if (provider.url === undefined) {
    throw new Refusal(
      424,
      'ProviderNotConfigured',
      'Setting a payout account needs the payment provider, which is not configured.',
    );
  }
  const answer = await answerTo(provider.url, provider.timeoutMs, `/accounts/${encodeURIComponent(accountId)}`, {
    method: 'GET',
  });
  if (answer?.status === 200 && isAccountOf(answer.body, accountId)) return;
  if (answer?.status === 404) {
    throw new Refusal(422, 'PayoutAccountIsUnknown', 'The payment provider does not know this account.');
  }
  throw new Refusal(424, 'ProviderUnavailable', ACCOUNT_UNAVAILABLE);
}

/**
 * Asks the provider to refund the payment `paymentId` at the provider, with `reference` (the settlement's id),
 * and answers the refund's id. The provider answers `201 { id }` within the time limit, or the refund is refused
 * with `424`, as {@link requestPayment} refuses a payment; a provider not configured is refused with `424` too.
 */
export async function requestRefund(
  provider: ProviderConfig,
  input: { paymentId: string; reference: string },
): Promise<ProviderRefund> {
  if (provider.url === undefined) {
    throw new Refusal(424, 'ProviderNotConfigured', 'Refunding through the provider is not configured.');
  }
  const path = `/payments/${encodeURIComponent(input.paymentId)}/refunds`;
  const body = await createdAt(provider.url, provider.timeoutMs, path, { reference: input.reference });
  if (isRefund(body)) return { id: body.id };
  throw new Refusal(424, 'ProviderUnavailable', REFUND_UNAVAILABLE);
}

function isAccountOf(value: unknown, accountId: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return (value as Record<string, unknown>).id === accountId;
}

function isRefund(value: unknown): value is ProviderRefund {
  if (typeof value !== 'object' || value === null) return false;
  const { id } = value as Record<string, unknown>;
  return typeof id === 'string' && id.length > 0;
}

function isPayment(value: unknown): value is ProviderPayment {
  if (typeof value !== 'object' || value === null) return false;
  const { id, payUrl, fee } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    typeof payUrl === 'string' &&
    payUrl.length > 0 &&
    typeof fee === 'number' &&
    Number.isSafeInteger(fee) &&
    fee >= 0
  );
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
