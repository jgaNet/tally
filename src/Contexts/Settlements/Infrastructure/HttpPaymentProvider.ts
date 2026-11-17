import {
  IPaymentProvider,
  PaymentLink,
  PaymentLinkRequest,
  RefundRequest,
} from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { KnownPayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

/** The provider's limit on an answer, in milliseconds: past it, the request is refused, and nothing is kept. */
export const PROVIDER_TIMEOUT_MS = 5000;

/**
 * The payment provider over its HTTP API: `POST {PROVIDER_URL}/payments` with `{ reference, amount, currency, payee }`, answered
 * `201 { id, payUrl }`. Any other answer, or no answer within the limit, is no link (`null`). `PROVIDER_URL` is read when a payment is
 * asked, so a server started without it refuses paying through the provider and nothing else.
 */
export class HttpPaymentProvider implements IPaymentProvider {
  constructor(
    private baseUrl: () => string | undefined = () => process.env.PROVIDER_URL,
    private timeoutMs = PROVIDER_TIMEOUT_MS,
  ) {}

  async requestPaymentLink({ reference, amount, currency, payee }: PaymentLinkRequest): Promise<PaymentLink | null> {
    const base = this.baseUrl();
    if (!base) return null;
    try {
      const response = await fetch(`${base}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference, amount, currency, payee }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return null;
      const body = (await response.json()) as { id?: unknown; payUrl?: unknown };
      if (typeof body.id !== 'string' || typeof body.payUrl !== 'string' || !body.id || !body.payUrl) return null;
      return { paymentId: body.id, payUrl: body.payUrl };
    } catch {
      return null;
    }
  }

  /**
   * `POST {PROVIDER_URL}/payments/{paymentId}/refunds` with `{ reference }`: accepted only as `201 { id }`. Any other answer, or no
   * answer within the limit, refuses the refund, and nothing is kept.
   */
  async requestRefund({ paymentId, reference }: RefundRequest): Promise<boolean> {
    const base = this.baseUrl();
    if (!base) return false;
    try {
      const response = await fetch(`${base}/payments/${encodeURIComponent(paymentId)}/refunds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return false;
      const body = (await response.json()) as { id?: unknown };
      return typeof body.id === 'string' && body.id.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * `GET {PROVIDER_URL}/accounts/{id}`: the provider knows the account when it answers `200 { id }`. Any other answer, or no answer
   * within the limit, is no answer (`null`), and the payout account is refused.
   */
  async payoutAccountOf(accountId: string): Promise<KnownPayoutAccount | null> {
    const base = this.baseUrl();
    if (!base) return null;
    try {
      const response = await fetch(`${base}/accounts/${encodeURIComponent(accountId)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 200) return null;
      const body = (await response.json()) as { id?: unknown };
      return typeof body.id === 'string' && body.id.length > 0 ? { id: body.id } : null;
    } catch {
      return null;
    }
  }
}
