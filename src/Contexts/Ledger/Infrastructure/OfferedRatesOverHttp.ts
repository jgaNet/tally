import { IOfferedRates } from '@Contexts/Ledger/Application/IOfferedRates';
import { isRate, RateOffer } from '@Contexts/Ledger/Domain/Expense/Rate';

/** How long the rates service has to answer before no rate is offered (request 22). */
export const RATES_TIMEOUT_MS = 5000;

/**
 * Answers Ledger's `IOfferedRates` port over the rates service's API (request 22): `GET {RATES_URL}/rates/{from}/{to}?date={date}`, whose
 * `200 { rate }` is the rate offered, the rate written as request 21 writes one. Any other answer, a rate that is not one, a timeout, or a
 * network failure is no rate (`none`). A server with no `RATES_URL` has no rates service at all (`no-service`). The URL is read when a
 * request comes, not when the modules are built (ADR 7), and is the base of the API without a trailing slash.
 */
export class OfferedRatesOverHttp implements IOfferedRates {
  constructor(
    private readonly baseUrl: () => string | undefined,
    private readonly timeoutMs: number = RATES_TIMEOUT_MS,
  ) {}

  async rateFor({ from, to, date }: { from: string; to: string; date: string }): Promise<RateOffer> {
    const base = this.baseUrl();
    if (!base) return { kind: 'no-service' };
    try {
      const url = `${base}/rates/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${encodeURIComponent(date)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (response.status !== 200) return { kind: 'none' };
      const body = (await response.json()) as { rate?: unknown };
      return isRate(body.rate) ? { kind: 'rate', rate: body.rate } : { kind: 'none' };
    } catch {
      return { kind: 'none' };
    }
  }
}
