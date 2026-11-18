import { IOfferedRates } from '@Contexts/Ledger/Application/IOfferedRates';
import { OfferedRate, isPositiveRate } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';

/** How long the rates service has to answer, in milliseconds: past it, there is no rate offered (request 22). */
export const RATES_TIMEOUT_MS = 5000;

/**
 * The rates service over its HTTP API (request 22): `GET {RATES_URL}/rates/{from}/{to}?date={date}`, answered `200 { rate }` with what
 * one `from` is worth in `to` on that day, written as a decimal string greater than 0 with at most 6 digits after the point. Any other
 * answer, a body that is not that, no answer within the timeout, or a rate the service did not write as one, is no rate offered. With
 * no base URL (`RATES_URL` is not set) there is no service at all, which the expense takes as request 21 does. It never throws.
 */
export class HttpOfferedRates implements IOfferedRates {
  constructor(private readonly baseUrl: string | undefined) {}

  async rateOf(from: string, to: string, date: string): Promise<OfferedRate> {
    if (!this.baseUrl) return { kind: 'no-service' };
    try {
      const url = `${this.baseUrl}/rates/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${encodeURIComponent(date)}`;
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(RATES_TIMEOUT_MS) });
      if (response.status !== 200) return { kind: 'none' };
      const answer = (await response.json()) as { rate?: unknown } | null;
      return typeof answer?.rate === 'string' && isPositiveRate(answer.rate)
        ? { kind: 'rate', rate: answer.rate }
        : { kind: 'none' };
    } catch {
      return { kind: 'none' };
    }
  }
}
