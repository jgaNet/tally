import { IResult, Result } from '@Architecture/Domain';
import { IPaymentProvider, PaymentLink } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { ProviderUnavailable, RefundUnavailable } from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/**
 * The payment provider over HTTP (ADR 8, ADR 9): `POST {PROVIDER_URL}/payments` with `{ reference, amount, currency }`, answered
 * `201 { id, payUrl }`; and `POST {PROVIDER_URL}/payments/{paymentId}/refunds` with `{ reference }`, answered `201 { id }`.
 * Anything else, an answer after 5 seconds, or no `PROVIDER_URL` at all, is `ProviderUnavailable` for a payment and
 * `RefundUnavailable` for a refund.
 */
export class HttpPaymentProvider implements IPaymentProvider {
  constructor(
    private readonly baseUrl: string | undefined,
    private readonly timeoutMs: number = 5000,
  ) {}

  async createPayment(payment: { reference: string; amount: number; currency: string }): Promise<IResult<PaymentLink>> {
    if (!this.baseUrl) return Result.fail(new ProviderUnavailable());
    try {
      const response = await fetch(`${this.baseUrl}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payment),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return Result.fail(new ProviderUnavailable());
      const body = (await response.json()) as { id?: unknown; payUrl?: unknown };
      if (typeof body.id !== 'string' || !body.id || typeof body.payUrl !== 'string' || !body.payUrl) {
        return Result.fail(new ProviderUnavailable());
      }
      return Result.ok({ id: body.id, payUrl: body.payUrl });
    } catch {
      return Result.fail(new ProviderUnavailable());
    }
  }

  async refundPayment(refund: { paymentId: string; reference: string }): Promise<IResult> {
    if (!this.baseUrl) return Result.fail(new RefundUnavailable());
    try {
      const response = await fetch(`${this.baseUrl}/payments/${encodeURIComponent(refund.paymentId)}/refunds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference: refund.reference }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return Result.fail(new RefundUnavailable());
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== 'string' || !body.id) return Result.fail(new RefundUnavailable());
      return Result.ok();
    } catch {
      return Result.fail(new RefundUnavailable());
    }
  }
}
