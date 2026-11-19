import { IResult, Result } from '@Architecture/Domain';
import { IPaymentProvider, PaymentLink } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import {
  ProviderAccountUnavailable,
  ProviderUnavailable,
  RefundUnavailable,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/**
 * The payment provider over HTTP (ADR 8, ADR 9, ADR 10): `POST {PROVIDER_URL}/payments` with `{ reference, amount, currency, payee }`,
 * answered `201 { id, payUrl, fee }`, `fee` the provider's fee in hundredths (request 38); `POST {PROVIDER_URL}/payments/{paymentId}/refunds` with `{ reference }`, answered `201 { id }`;
 * and `GET {PROVIDER_URL}/accounts/{id}`, answered `200 { id }` for an account it knows and `404` for one it does not. Anything
 * else, an answer after 5 seconds, or no `PROVIDER_URL` at all, is `ProviderUnavailable` for a payment, `RefundUnavailable` for
 * a refund and `ProviderAccountUnavailable` for an account.
 */
export class HttpPaymentProvider implements IPaymentProvider {
  constructor(
    private readonly baseUrl: string | undefined,
    private readonly timeoutMs: number = 5000,
  ) {}

  async findPayoutAccount(accountId: string): Promise<IResult<{ id: string } | null>> {
    if (!this.baseUrl) return Result.fail(new ProviderAccountUnavailable());
    try {
      const response = await fetch(`${this.baseUrl}/accounts/${encodeURIComponent(accountId)}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 404) return Result.ok(null);
      if (response.status !== 200) return Result.fail(new ProviderAccountUnavailable());
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== 'string' || body.id !== accountId) return Result.fail(new ProviderAccountUnavailable());
      return Result.ok({ id: body.id });
    } catch {
      return Result.fail(new ProviderAccountUnavailable());
    }
  }

  async createPayment(payment: {
    reference: string;
    amount: number;
    currency: string;
    payee: string;
  }): Promise<IResult<PaymentLink>> {
    if (!this.baseUrl) return Result.fail(new ProviderUnavailable());
    try {
      const response = await fetch(`${this.baseUrl}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payment),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return Result.fail(new ProviderUnavailable());
      const body = (await response.json()) as { id?: unknown; payUrl?: unknown; fee?: unknown };
      if (typeof body.id !== 'string' || !body.id || typeof body.payUrl !== 'string' || !body.payUrl) {
        return Result.fail(new ProviderUnavailable());
      }
      // An answer without the provider's fee, a whole number, is not an answer (request 38); the book decides its range.
      if (typeof body.fee !== 'number' || !Number.isInteger(body.fee)) return Result.fail(new ProviderUnavailable());
      return Result.ok({ id: body.id, payUrl: body.payUrl, fee: body.fee });
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
