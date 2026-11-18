/** One member's share of an expense, as a member reads it. */
export interface ShareReadModel {
  memberId: string;
  amount: number;
}

import { SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';

/** What an expense was paid in another currency, as a member reads it: the rate is the string the payer gave. */
export interface OriginalReadModel {
  currency: string;
  amount: number;
  rate: string;
}

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
  /** Only for an expense paid in another currency than its group's: what it was paid in, its `amount` being the group's (request 21). */
  original?: OriginalReadModel;
  /** 1 when it is recorded, one more at each edit: the version an edit is made from. */
  version: number;
}
