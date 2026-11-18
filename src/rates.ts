import type { FastifyInstance } from 'fastify';
import type { Database } from './database';
import { isRealDay, todayUtc } from './days';
import { CURRENCIES, findGroupOf } from './groups';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/**
 * How Tally reaches the rates service: the base of its API (`RATES_URL`, without a trailing slash), and how long it may
 * take to answer (5 seconds, unless a test says otherwise). Without a URL, no rate is offered.
 */
export interface RatesConfig {
  url?: string;
  timeoutMs?: number;
}

/** A rate is kept as a whole number of millionths, so that the conversion is exact. */
export const MILLIONTHS = 1_000_000n;

/** A rate, as a decimal string: whole digits, and at most 6 digits after the point. */
const RATE_SHAPE = /^(\d+)(?:\.(\d{1,6}))?$/;

/** The rate as a whole number of millionths, when it is a decimal string greater than 0 with at most 6 digits after the point. */
export function rateMillionths(rate: string): bigint | undefined {
  const match = RATE_SHAPE.exec(rate);
  if (!match) return undefined;
  const millionths = BigInt(match[1] + (match[2] ?? '').padEnd(6, '0'));
  return millionths > 0n ? millionths : undefined;
}

/**
 * The rate the rates service offers for one `from` in `to` on `date`: its `rate`, when it answers `200` with a rate written
 * as a rate is. Any other answer, a `404` included, an answer that is not one, or none within the time allowed, offers no rate.
 */
export async function offeredRate(
  config: RatesConfig,
  input: { from: string; to: string; date: string },
): Promise<string | undefined> {
  if (!config.url) return undefined;
  const path = `/rates/${encodeURIComponent(input.from)}/${encodeURIComponent(input.to)}`;
  try {
    const response = await fetch(`${config.url}${path}?date=${encodeURIComponent(input.date)}`, {
      signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return undefined;
    }
    const answer = (await response.json()) as { rate?: unknown } | null;
    const rate = answer?.rate;
    return typeof rate === 'string' && rateMillionths(rate) !== undefined ? rate : undefined;
  } catch {
    return undefined;
  }
}

const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/** The rate offered, as it is read: the currency, the day, and the rate as a decimal string. */
const rateSchema = {
  type: 'object',
  required: ['currency', 'date', 'rate'],
  properties: {
    currency: { type: 'string', enum: [...CURRENCIES] },
    date: { type: 'string', pattern: DATE_PATTERN },
    rate: { type: 'string', pattern: '^\\d+(\\.\\d{1,6})?$' },
  },
};

export function registerRateRoutes(app: FastifyInstance, db: Database, rates: RatesConfig): void {
  app.get<{ Params: { id: string; currency: string }; Querystring: { date?: string } }>(
    '/groups/:id/rates/:currency',
    {
      schema: {
        querystring: { type: 'object', properties: { date: { type: 'string', pattern: DATE_PATTERN } } },
        response: { 200: rateSchema },
      },
    },
    async request => {
      const accountId = await requireCaller(db, request);
      const group = await findGroupOf(db, accountId, request.params.id);
      if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
      const { currency } = request.params;
      const date = request.query.date ?? todayUtc();
      if (!isRealDay(date)) {
        throw new Refusal(422, 'InvalidDate', 'The date must be a day of the calendar, as YYYY-MM-DD.');
      }
      // A rate is offered between Tally's currencies only, and not from the group's currency to itself.
      if (!(CURRENCIES as readonly string[]).includes(currency) || currency === group.currency) {
        throw new Refusal(404, 'NoRateOffered', `No rate is offered from ${currency} to ${group.currency}.`);
      }
      const rate = await offeredRate(rates, { from: currency, to: group.currency, date });
      if (rate === undefined) {
        throw new Refusal(404, 'NoRateOffered', `No rate is offered from ${currency} to ${group.currency} on ${date}.`);
      }
      return { currency, date, rate };
    },
  );
}
