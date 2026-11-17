import { IOfferedRates } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { isOfferableRate, OfferedRate } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';

/** How long the rates service may take to answer a rate before there is none (request 22): 5 seconds. */
export const RATES_TIMEOUT_MS = 5000;

const NONE: OfferedRate = { kind: 'none' };
const UNAVAILABLE: OfferedRate = { kind: 'unavailable' };

/**
 * The rates service over its HTTP API (request 22, docs/adr/0021): `GET {RATES_URL}/rates/{from}/{to}?date={date}`, answered `200 { rate }`
 * with the rate, a decimal number in a string, greater than 0, of at most 6 digits after the point; `404` when it has no rate. Any other
 * answer, a body that is not that, a failure to reach it, or no answer within 5 seconds, is no rate offered (`none`). The base is read at
 * each request, from the environment, as the payment provider's is: with no `RATES_URL` the server offers no rate service at all
 * (`unavailable`), and the payer's rate stands (request 21).
 */
export class HttpOfferedRates implements IOfferedRates {
  constructor(
    private readonly baseUrl: () => string | undefined = () => process.env.RATES_URL,
    private readonly timeoutMs: number = RATES_TIMEOUT_MS,
  ) {}

  async offeredRate({ from, to, date }: { from: string; to: string; date: string }): Promise<OfferedRate> {
    const base = this.baseUrl()?.replace(/\/+$/, '');
    if (!base) return UNAVAILABLE;
    try {
      const response = await fetch(
        `${base}/rates/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${encodeURIComponent(date)}`,
        { method: 'GET', signal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (response.status !== 200) return NONE;
      const body = parseJson(await response.text());
      const rate = typeof body === 'object' && body !== null ? (body as { rate?: unknown }).rate : undefined;
      return isOfferableRate(rate) ? { kind: 'offered', rate } : NONE;
    } catch {
      return NONE;
    }
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
