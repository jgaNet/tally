import { ISettlementRates } from '@Contexts/Settlements/Application/ISettlementRates';

/** How long the rates service has to answer, in milliseconds: past it, there is no rate offered (request 22). */
export const RATES_TIMEOUT_MS = 5000;

/** The rate as the service writes it: a decimal with at most six digits after the point, and some digit that is not 0 (request 22). */
const RATE_PATTERN = /^\d+(\.\d{1,6})?$/;

/**
 * The rates service over its HTTP API (request 22), as Settlements asks it (request 39): `GET {RATES_URL}/rates/{from}/{to}?date={date}`,
 * answered `200 { rate }` with what one `from` is worth in `to` on that day, a positive decimal with at most six digits after the point.
 * Any other answer, a body that is not that, no answer within the timeout, or no base URL (`RATES_URL` is not set), offers no rate. It never throws.
 */
export class HttpSettlementRates implements ISettlementRates {
  constructor(private readonly baseUrl: string | undefined) {}

  async rateOf(from: string, to: string, date: string): Promise<string | undefined> {
    if (!this.baseUrl) return undefined;
    try {
      const url = `${this.baseUrl}/rates/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${encodeURIComponent(date)}`;
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(RATES_TIMEOUT_MS) });
      if (response.status !== 200) return undefined;
      const answer = (await response.json()) as { rate?: unknown } | null;
      const rate = answer?.rate;
      return typeof rate === 'string' && RATE_PATTERN.test(rate) && /[1-9]/.test(rate) ? rate : undefined;
    } catch {
      return undefined;
    }
  }
}
