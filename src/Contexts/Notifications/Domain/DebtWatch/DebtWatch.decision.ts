import { decided, Decision } from '@Architecture/Domain/Lite/Decision';
import { minorUnitDecimals } from '@SharedKernel/Domain';

/** More than this many units of the group's currency is a debt that is worth a reminder (request 18, request 40): 20. */
export const REMINDER_UNITS = 20;

/**
 * The least a debt must be to be worth a reminder, in the minor unit of `currency` (ADR 38): more than 20 of it, so 2000 in a currency that
 * counts in hundredths (request 18), 20 in one that has no minor unit, 20 000 in one that counts in thousandths (request 40).
 */
export const reminderThresholdOf = (currency: string): number => REMINDER_UNITS * 10 ** minorUnitDecimals(currency);

/** What a run has seen of one member in one group: since which run they owe more than the threshold, and when they were last reminded. */
export interface WatchState {
  /** The time of the run that saw them owe more than the threshold, `null` when they are not noted. */
  notedSince: string | null;
  /** The time of the run that last reminded them, kept when the debt is cleared. `null` when they never were. */
  remindedAt: string | null;
}

/**
 * What one run sees: what the member still owes (0 when nothing, or when they are no longer a member), the amount above which a debt is
 * worth a reminder (`reminderThresholdOf`), how long a period is, and whether a reminder may be made to them now, which is whether they
 * have reminders on (request 36, ADR 34).
 */
export interface SeeDebt {
  owed: number;
  threshold: number;
  periodMs: number;
  remindable: boolean;
}

export type DebtFact = { type: 'DebtNoted' } | { type: 'DebtCleared' } | { type: 'ReminderDue'; owed: number };

const NEVER: WatchState = { notedSince: null, remindedAt: null };

/**
 * One run's look at one member of one group (request 18, ADR 15): noted from this run when they owe more than the threshold and were
 * not noted; no longer noted when they owe the threshold or less; reminded when noted for a period or more and not reminded during
 * the last period, and only while reminders are on for them. A pure function of what was kept (`undefined` for a member never noted), what the
 * run saw and the run's time; nothing is refused, and nothing changes (no fact) when the run sees nothing new, or a reminder is due but off.
 */
export const decideSeeDebt: Decision<WatchState, SeeDebt, DebtFact, WatchState | undefined> = (
  kept,
  { owed, threshold, periodMs, remindable },
  now,
) => {
  const state = kept ?? NEVER;
  if (owed <= threshold) {
    return state.notedSince === null
      ? decided(state)
      : decided({ ...state, notedSince: null }, { type: 'DebtCleared' });
  }
  const at = now.toISOString();
  if (state.notedSince === null) return decided({ ...state, notedSince: at }, { type: 'DebtNoted' });
  const lasted = now.getTime() - Date.parse(state.notedSince) >= periodMs;
  const sinceReminder = state.remindedAt === null ? Infinity : now.getTime() - Date.parse(state.remindedAt);
  // A reminder that is not made does not count as made: turned off, it is not due, and the state stays as it was (request 36).
  if (lasted && sinceReminder >= periodMs && remindable) {
    return decided({ ...state, remindedAt: at }, { type: 'ReminderDue', owed });
  }
  return decided(state);
};
