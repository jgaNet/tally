import { IPaymentProvider, PaymentLink } from '@Contexts/Settlements/Application/IPaymentProvider';

/** How long the provider has to give a payment link before the request is refused (request 13). */
export const PROVIDER_TIMEOUT_MS = 5000;

/**
 * Answers Settlements' `IPaymentProvider` port over the provider's API (request 13): `POST {PROVIDER_URL}/payments` with `{ reference,
 * amount, currency }`, whose `201 { id, payUrl }` is the link. Any other answer, a timeout, a network failure, or no `PROVIDER_URL` at
 * all is no link (`undefined`), and the use case refuses the request with nothing kept. The URL is read when a request comes, not when
 * the modules are built (ADR 7), and is the base of the API without a trailing slash.
 */
export class PaymentProviderOverHttp implements IPaymentProvider {
  constructor(
    private readonly baseUrl: () => string | undefined,
    private readonly timeoutMs: number = PROVIDER_TIMEOUT_MS,
  ) {}

  async paymentLinkFor(payment: {
    reference: string;
    amount: number;
    currency: string;
  }): Promise<PaymentLink | undefined> {
    const base = this.baseUrl();
    if (!base) return undefined;
    try {
      const response = await fetch(`${base}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payment),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return undefined;
      const body = (await response.json()) as { id?: unknown; payUrl?: unknown };
      if (typeof body.id !== 'string' || body.id === '') return undefined;
      if (typeof body.payUrl !== 'string' || body.payUrl === '') return undefined;
      return { id: body.id, payUrl: body.payUrl };
    } catch {
      return undefined;
    }
  }

  /**
   * `POST {PROVIDER_URL}/payments/{paymentId}/refunds` with `{ reference }` (request 15): `201 { id }` is the refund accepted. Any other
   * answer, a timeout, a network failure, or no `PROVIDER_URL` is a refusal (`false`), and the request is refused with nothing changed.
   */
  async refundPayment({ paymentId, reference }: { paymentId: string; reference: string }): Promise<boolean> {
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
      return typeof body.id === 'string' && body.id !== '';
    } catch {
      return false;
    }
  }
}
