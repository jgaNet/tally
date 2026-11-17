import type { DatabaseSync } from 'node:sqlite';
import { isCalendarDay, todayInUtc } from './days';
import { CURRENCIES, findGroupOfMember, type Currency } from './groups';
import { Refusal } from './refusal';

/**
 * The rates service Tally asks the rate of a currency to another on a day: `url` is the base of its API (without a
 * trailing slash), absent when no rates service is configured; `timeoutMs` is how long it has to answer (5000 by default).
 */
export interface RatesConfig {
  readonly url: string | undefined;
  readonly timeoutMs: number;
}

/** A rate: a decimal number written with at most 6 digits after the point, such as `0.9542`, `1` or `12.5`. */
export const RATE_SHAPE = /^\d+(\.\d{1,6})?$/;

/** A rate's digits as a whole number of millionths: `"0.9542"` is 954200, `"12.5"` is 12500000. The rate has the shape already. */
export function millionthsOf(rate: string): bigint {
  const [whole, fraction = ''] = rate.split('.');
  return BigInt(`${whole}${fraction.padEnd(6, '0')}`);
}

/** True when `value` is a rate: a string of the rate's shape, greater than 0. */
export function isRate(value: unknown): value is string {
  return typeof value === 'string' && RATE_SHAPE.test(value) && millionthsOf(value) > 0n;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The rate the rates service offers from `from` to `to` on `date`, as it answers `200 { rate }` within the time limit.
 * Any other answer (a `404` included), a `rate` that is not a rate, an answer that is not JSON, a body that does not
 * arrive in time, no answer at all, and no rates service configured give `undefined`: no rate is offered. It changes
 * nothing at the service.
 */
export async function offeredRate(
  rates: RatesConfig,
  input: { from: string; to: string; date: string },
): Promise<string | undefined> {
  if (rates.url === undefined) return undefined;
  const { from, to, date } = input;
  const path = `/rates/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${encodeURIComponent(date)}`;
  try {
    const response = await fetch(`${rates.url}${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(rates.timeoutMs),
    });
    // The body is read inside the time limit: one that does not arrive in time is an answer that never came.
    const text = await response.text();
    if (response.status !== 200) return undefined;
    const body = parseJson(text);
    if (typeof body !== 'object' || body === null) return undefined;
    const { rate } = body as Record<string, unknown>;
    return isRate(rate) ? rate : undefined;
  } catch {
    return undefined;
  }
}

/** The rate offered from `currency` to the group's currency on `date`, as a member of the group asks it. */
export interface OfferedRateOfGroup {
  readonly currency: Currency;
  readonly date: string;
  readonly rate: string;
}

/**
 * The rate Tally offers from `currency` to the group's currency on `date` (today, UTC, when `date` is absent), as the
 * rates service gives it. Only a member of the group asks it (else `404`, as if the group did not exist). Refused with
 * `404` when the currency is not one of Tally's or is the group's own, or when no rate is offered; with `422` when the
 * date is not a real day of the calendar. It changes nothing.
 */
export async function ratesOfferedToGroup(
  db: DatabaseSync,
  rates: RatesConfig,
  input: { accountId: string; groupId: string; currency: string; date: string | undefined },
): Promise<OfferedRateOfGroup> {
  const { accountId, groupId, currency } = input;
  const group = findGroupOfMember(db, accountId, groupId);
  if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
  const date = input.date ?? todayInUtc();
  if (!isCalendarDay(date)) {
    throw new Refusal(422, 'DateIsInvalid', 'The date must be a real day of the calendar, written YYYY-MM-DD.');
  }
  const isOtherCurrency = (CURRENCIES as readonly string[]).includes(currency) && currency !== group.currency;
  const rate = isOtherCurrency ? await offeredRate(rates, { from: currency, to: group.currency, date }) : undefined;
  if (rate === undefined) {
    throw new Refusal(404, 'RateNotOffered', 'No rate is offered from this currency to the group’s on this day.');
  }
  return { currency: currency as Currency, date, rate };
}
