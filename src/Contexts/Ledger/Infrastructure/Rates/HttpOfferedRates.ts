import { IOfferedRates, RateQuery } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { rateMillionths } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { RateOffer } from '@Contexts/Ledger/Domain/Expense/RateOffer';

/** How long the rates service has to answer before no rate is offered (request 22). */
export const RATES_ANSWER_DEADLINE_MS = 5000;

const NONE: RateOffer = { kind: 'none' };

/**
 * Ledger's adapter onto the rates service over its HTTP API: `GET {RATES_URL}/rates/{from}/{to}?date={date}`, answered
 * `200 { rate }`, the rate of one `from` in `to` on that day, or `404` when it has no rate (request 22). Any other answer, a rate
 * that is not a decimal greater than 0 of at most 6 digits after the point, or no answer within 5 seconds, is no rate offered.
 * Without a base URL nothing is asked and the server is taken to offer no service at all. The base URL is read when a rate is
 * asked, so the wiring can be configured at start.
 */
export class HttpOfferedRates implements IOfferedRates {
  constructor(private baseUrl: () => string | undefined) {}

  async rateOf({ from, to, date }: RateQuery): Promise<RateOffer> {
    const base = this.baseUrl();
    if (!base) return { kind: 'unconfigured' };

    try {
      const path = `/rates/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${encodeURIComponent(date)}`;
      const response = await fetch(`${base}${path}`, {
        method: 'GET',
        signal: AbortSignal.timeout(RATES_ANSWER_DEADLINE_MS),
      });
      if (response.status !== 200) return NONE;

      const body = (await response.json()) as { rate?: unknown };
      return typeof body.rate === 'string' && rateMillionths(body.rate) !== null
        ? { kind: 'offered', rate: body.rate }
        : NONE;
    } catch {
      return NONE;
    }
  }
}
