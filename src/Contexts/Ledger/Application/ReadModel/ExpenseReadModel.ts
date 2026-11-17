/** One member's share of an expense, as a member reads it. */
export interface ShareReadModel {
  memberId: string;
  amount: number;
}

import { SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';

/** An expense as a member of its group reads it: what it was for, what it cost, when, who paid, how it was split, each share, and its version. */
export interface ExpenseReadModel {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  /** `equal`, `exact` or `shares`: how the expense was split. The expenses recorded before splits had kinds were `equal`. */
  splitKind: SplitKind;
  shares: ShareReadModel[];
  /** 1 when it is recorded, one more at each edit: the version an edit is made from. */
  version: number;
}
