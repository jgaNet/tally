import { RateSource } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';

/** One member's share of an expense, as it is kept. */
export interface ShareSnapshot {
  memberId: string;
  amount: number;
}

/**
 * What was paid in another currency, as it is kept: the currency, the amount in its hundredths, the rate as it was stated or
 * offered, and where that rate came from (request 22; the source is not in the API).
 */
export interface OriginalSnapshot {
  currency: string;
  amount: number;
  rate: string;
  rateSource: RateSource;
}

/**
 * What an expense is made of, as it is kept: its amount in the group's currency and its day, the payer, how it was split and
 * each member's share in the order the split was given, and what was paid in another currency, if it was (`null` otherwise).
 * Its id is the one it was born with; its version is the one it was last saved at (1 when recorded). An expense recorded
 * before splits had kinds was split equally.
 */
export interface ExpenseSnapshot {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  splitKind: SplitKind;
  shares: ShareSnapshot[];
  original: OriginalSnapshot | null;
  /** What it is for (request 24): one of the eight categories; an expense kept before categories is `other`. */
  category: string;
  version: number;
}
