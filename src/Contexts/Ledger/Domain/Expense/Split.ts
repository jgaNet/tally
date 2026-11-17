import { IResult, Result } from '@Architecture/Domain';

import { ShareSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import {
  DuplicateInSplitException,
  NotAMemberInSplitException,
  PayerNotInSplitException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/**
 * How an expense's amount is shared between the members it concerns (the storm, hot spot 3). An equal split: each member
 * owes the amount divided by their number, rounded down; what is left over, less than their number, goes whole to the
 * payer. The shares add up to the amount exactly, and they are kept in the order the split was given.
 *
 * `equally()` refuses a split a member is listed twice in, one with someone who is not a current member, or one without
 * its payer. `fromShares()` reads the shares the store kept; the expense checks that they add up.
 */
export class Split {
  readonly #shares: ShareSnapshot[];

  private constructor(shares: ShareSnapshot[]) {
    this.#shares = shares;
  }

  static equally({
    amount,
    between,
    payerId,
    members,
  }: {
    amount: number;
    between: string[];
    payerId: string;
    members: string[];
  }): IResult<Split> {
    if (new Set(between).size !== between.length) {
      return Result.fail(new DuplicateInSplitException());
    }
    const currentMembers = new Set(members);
    if (between.some(memberId => !currentMembers.has(memberId))) {
      return Result.fail(new NotAMemberInSplitException());
    }
    if (!between.includes(payerId)) {
      return Result.fail(new PayerNotInSplitException());
    }
    const each = Math.floor(amount / between.length);
    const remainder = amount - each * between.length;
    return Result.ok(
      new Split(between.map(memberId => ({ memberId, amount: memberId === payerId ? each + remainder : each }))),
    );
  }

  static fromShares(shares: ShareSnapshot[]): Split {
    return new Split(shares.map(share => ({ ...share })));
  }

  get shares(): ShareSnapshot[] {
    return this.#shares.map(share => ({ ...share }));
  }

  get total(): number {
    return this.#shares.reduce((sum, share) => sum + share.amount, 0);
  }
}
