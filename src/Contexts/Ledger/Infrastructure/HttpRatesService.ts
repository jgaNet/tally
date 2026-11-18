import { isCurrencyCode } from '@SharedKernel/Domain/Currency';

import { IOfferedRates, OfferedRateRequest } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { isValidRate } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { RateOffer } from '@Contexts/Ledger/Domain/Expense/RateOffer';

/** The rates service's limit on an answer, in milliseconds: past it, the request is refused and no rate is offered. */
export const RATES_TIMEOUT_MS = 5000;

const NONE: RateOffer = { kind: 'none' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The rates service over its HTTP API: `GET {RATES_URL}/rates/{from}/{to}?date={date}`, answered `200 { rate }` when it offers one, and
 * `404` when it has none. Any other answer, a rate that is not valid, or no answer within the limit, is `none`. `RATES_URL` is read
 * when a rate is asked, so a server started without it offers no rate and takes the payer's rate (`no-service`), and nothing else
 * changes. A request that cannot name two currencies of Tally's and a day is not sent: it has no rate.
 */
export class HttpRatesService implements IOfferedRates {
  constructor(
    private baseUrl: () => string | undefined = () => process.env.RATES_URL,
    private timeoutMs = RATES_TIMEOUT_MS,
  ) {}

  async rateOn({ from, to, date }: OfferedRateRequest): Promise<RateOffer> {
    const base = this.baseUrl();
    if (!base) return { kind: 'no-service' };
    if (!isCurrencyCode(from) || !isCurrencyCode(to) || from === to || !DAY.test(date)) return NONE;
    try {
      const response = await fetch(`${base}/rates/${from}/${to}?date=${date}`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 200) return NONE;
      const body = (await response.json()) as { rate?: unknown };
      return typeof body.rate === 'string' && isValidRate(body.rate) ? { kind: 'offered', rate: body.rate } : NONE;
    } catch {
      return NONE;
    }
  }
}
