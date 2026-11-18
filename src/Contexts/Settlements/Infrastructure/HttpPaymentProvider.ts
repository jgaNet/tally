import { IPaymentProvider, PaymentRequest, RefundRequest } from '@Contexts/Settlements/Application/IPaymentProvider';
import { ProviderLink } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { ProviderPayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

/** How long the provider has to answer a payment request, in milliseconds: past it, the request is refused (request 13). */
export const PROVIDER_TIMEOUT_MS = 5000;

/**
 * The payment provider over its HTTP API (feature 13): `POST {PROVIDER_URL}/payments` with `{ reference, amount, currency, payee }`,
 * answered `201 { id, payUrl, fee }` (request 16: `payee` is the payee's payout account; request 38: `fee` is a whole number of hundredths). Any other answer, no answer within the timeout, a
 * body without a payment id and a link, or no base URL at all (`PROVIDER_URL` is not set), answers `undefined`: the request is refused
 * and nothing is kept. It never throws. `GET {PROVIDER_URL}/accounts/{id}` answers `200 { id }` for an account the provider knows
 * (request 16); any other answer, a timeout or no base URL answers `undefined`.
 */
export class HttpPaymentProvider implements IPaymentProvider {
  constructor(private readonly baseUrl: string | undefined) {}

  async requestPayment({ reference, amount, currency, payee }: PaymentRequest): Promise<ProviderLink | undefined> {
    if (!this.baseUrl) return undefined;
    try {
      const response = await fetch(`${this.baseUrl}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference, amount, currency, payee }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (response.status !== 201) return undefined;
      return linkOf(await response.json());
    } catch {
      return undefined;
    }
  }

  /**
   * `GET {PROVIDER_URL}/accounts/{id}` (request 16): `200 { id }` is an account the provider knows, answered with its id. Any other
   * answer, no answer within the timeout, a body without the id, or no base URL, answers `undefined`. It never throws.
   */
  async payoutAccountFor(accountId: string): Promise<ProviderPayoutAccount | undefined> {
    if (!this.baseUrl) return undefined;
    try {
      const response = await fetch(`${this.baseUrl}/accounts/${encodeURIComponent(accountId)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (response.status !== 200) return undefined;
      const answer = (await response.json()) as { id?: unknown } | null;
      return typeof answer?.id === 'string' && answer.id !== '' ? { id: answer.id } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * `POST {PROVIDER_URL}/payments/{paymentId}/refunds` with `{ reference }`, answered `201 { id }` (request 15): accepted. Any other answer,
   * no answer within the timeout, a body without the refund's id, or no base URL, is not accepted. It never throws.
   */
  async refundPayment({ paymentId, reference }: RefundRequest): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const response = await fetch(`${this.baseUrl}/payments/${encodeURIComponent(paymentId)}/refunds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (response.status !== 201) return false;
      const answer = (await response.json()) as { id?: unknown } | null;
      return typeof answer?.id === 'string' && answer.id !== '';
    } catch {
      return false;
    }
  }
}

/**
 * The provider's `{ id, payUrl, fee }`, when it says both as non-empty text and the fee as a whole number (request 38); anything else is no
 * link, and so no answer.
 */
function linkOf(answer: unknown): ProviderLink | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const { id, payUrl, fee } = answer as { id?: unknown; payUrl?: unknown; fee?: unknown };
  if (typeof id !== 'string' || id === '' || typeof payUrl !== 'string' || payUrl === '') return undefined;
  if (typeof fee !== 'number' || !Number.isInteger(fee)) return undefined;
  return { id, payUrl, fee };
}
