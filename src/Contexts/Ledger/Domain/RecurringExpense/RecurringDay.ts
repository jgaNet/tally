import { IResult, Result } from '@Architecture/Domain';

import { InvalidRecurringStartsOnException } from './RecurringExpenseExceptions';

/** The days a recurring expense can start on: a day of the month from 1 to 28, so that every month has it (request 23). */
const STARTS_ON = /^\d{4}-\d{2}-(0[1-9]|1\d|2[0-8])$/;
/** How far from today `startsOn` may be, in days, before and after (request 23). */
const MAX_DISTANCE_IN_DAYS = 365;
const DAY_MS = 86_400_000;

/** Whether `raw` is a day of the calendar written YYYY-MM-DD: 2026-02-30 is not, and reads back as another day. */
export const isRealDay = (raw: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
};

/** The day of the month `day` falls on, in the next month: the same day, since a recurring day is 1 to 28. */
export const monthAfter = (day: string): string => {
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month, dayOfMonth)).toISOString().slice(0, 10);
};

/** The days a recurring expense falls on, from its next day `next` up to and including `today`, in order: none if `next` is later. */
export const occurrencesUpTo = (next: string, today: string): string[] => {
  const days: string[] = [];
  for (let day = next; day <= today; day = monthAfter(day)) days.push(day);
  return days;
};

/**
 * The start of a recurring expense, as request 23 says it: a real day of the calendar, whose day of the month is from 1 to 28,
 * and no more than 365 days before `today` nor 365 days after (the UTC day of the decision).
 */
export const startsOnOf = (raw: string, today: string): IResult<string> => {
  if (!STARTS_ON.test(raw) || !isRealDay(raw)) return Result.fail(new InvalidRecurringStartsOnException());
  const distance = Math.round((Date.parse(`${raw}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  if (Math.abs(distance) > MAX_DISTANCE_IN_DAYS) return Result.fail(new InvalidRecurringStartsOnException());
  return Result.ok(raw);
};
