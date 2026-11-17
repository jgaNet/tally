import { PaymentLink } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import {
  IPaymentProvider,
  PaymentRefundRequest,
  PaymentRequest,
} from '@Contexts/Settlements/Application/Ports/IPaymentProvider';

/** How long the provider has to answer a payment link before the request is refused (request 13). */
export const PROVIDER_ANSWER_DEADLINE_MS = 5000;

/**
 * Settlements' adapter onto the payment provider over its HTTP API: `POST {PROVIDER_URL}/payments` with `{ reference, amount,
 * currency }`, answered `201 { id, payUrl }`. Any other answer, an answer that is not a link, or no answer within 5 seconds gives
 * null, which the book refuses as ProviderUnavailable. Without a base URL nothing is asked and null is given. The base URL is read
 * when a payment is asked, so the wiring can be configured at start.
 *
 * A refund is asked the same way: `POST {PROVIDER_URL}/payments/{paymentId}/refunds` with `{ reference }`, answered `201 { id }`.
 * Any other answer, or no answer within 5 seconds, is a refund not accepted (false), which the book refuses as ProviderUnavailable.
 */
export class HttpPaymentProvider implements IPaymentProvider {
  constructor(private baseUrl: () => string | undefined) {}

  async requestPayment({ reference, amount, currency }: PaymentRequest): Promise<PaymentLink | null> {
    const base = this.baseUrl();
    if (!base) return null;

    try {
      const response = await fetch(`${base}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference, amount, currency }),
        signal: AbortSignal.timeout(PROVIDER_ANSWER_DEADLINE_MS),
      });
      if (response.status !== 201) return null;

      const body = (await response.json()) as { id?: unknown; payUrl?: unknown };
      return typeof body.id === 'string' && typeof body.payUrl === 'string'
        ? { id: body.id, payUrl: body.payUrl }
        : null;
    } catch {
      return null;
    }
  }

  async refundPayment({ paymentId, reference }: PaymentRefundRequest): Promise<boolean> {
    const base = this.baseUrl();
    if (!base) return false;

    try {
      const response = await fetch(`${base}/payments/${encodeURIComponent(paymentId)}/refunds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference }),
        signal: AbortSignal.timeout(PROVIDER_ANSWER_DEADLINE_MS),
      });
      if (response.status !== 201) return false;

      const body = (await response.json()) as { id?: unknown };
      return typeof body.id === 'string' && body.id.length > 0;
    } catch {
      return false;
    }
  }
}
