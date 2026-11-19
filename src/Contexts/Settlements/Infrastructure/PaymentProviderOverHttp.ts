import { IPaymentProvider, PaymentLink } from '@Contexts/Settlements/Application/IPaymentProvider';

/** How long the provider has to give a payment link before the request is refused (request 13). */
export const PROVIDER_TIMEOUT_MS = 5000;

/**
 * Answers Settlements' `IPaymentProvider` port over the provider's API (request 13): `POST {PROVIDER_URL}/payments` with `{ reference,
 * amount, currency }`, whose `201 { id, payUrl, fee }` is the link (request 38: the fee it keeps, a whole number of hundredths). Any other answer, a timeout, a network failure, or no `PROVIDER_URL` at
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
    payee: string;
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
      const body = (await response.json()) as { id?: unknown; payUrl?: unknown; fee?: unknown };
      if (typeof body.id !== 'string' || body.id === '') return undefined;
      if (typeof body.payUrl !== 'string' || body.payUrl === '') return undefined;
      // The fee is what the provider keeps (request 38); an answer without one is no link, and the use case refuses it. Whether it is a
      // whole number that is less than the amount is the domain's to decide.
      return { id: body.id, payUrl: body.payUrl, fee: typeof body.fee === 'number' ? body.fee : undefined };
    } catch {
      return undefined;
    }
  }

  /**
   * `GET {PROVIDER_URL}/accounts/{id}` (request 16): `200 { id }` is the account the provider knows, answered with its id. Any other
   * answer, a timeout, a network failure, an empty id, or no `PROVIDER_URL` is no account (`undefined`).
   */
  async payoutAccountOf(accountId: string): Promise<string | undefined> {
    const base = this.baseUrl();
    if (!base || accountId === '') return undefined;
    try {
      const response = await fetch(`${base}/accounts/${encodeURIComponent(accountId)}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 200) return undefined;
      const body = (await response.json()) as { id?: unknown };
      return typeof body.id === 'string' && body.id !== '' ? body.id : undefined;
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
