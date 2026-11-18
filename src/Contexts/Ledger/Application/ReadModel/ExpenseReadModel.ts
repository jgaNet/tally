import { SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';

/** One member's share of an expense as a member reads it. */
export interface ExpenseShareReadModel {
  memberId: string;
  amount: number;
}

/** What an expense was paid in, in another currency, as a member reads it: the rate is the string the payer gave. */
export interface ExpenseOriginalReadModel {
  currency: string;
  amount: number;
  rate: string;
}

/**
 * An expense as a member of its group reads it: its description, amount, day, payer, how it was split, its version, and the
 * shares in split order. An expense paid in another currency also has `original` (request 21); one in the group's currency has none.
 */
export interface ExpenseReadModel {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  /** How it was split: equally, by exact amounts, or by shares. An expense recorded before splits had kinds is equal. */
  splitKind: SplitKind;
  /** The version it was last saved at: 1 when recorded, one more at each edit. */
  version: number;
  shares: ExpenseShareReadModel[];
  original?: ExpenseOriginalReadModel;
}
