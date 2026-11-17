import { Id, IResult, Result } from '@Architecture/Domain';

import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { DuplicateSplitMember, PayerNotInSplit } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What one member of a split owes of an expense: whole, in the same unit as the amount. */
export interface Share {
  memberId: Id;
  amount: number;
}

/**
 * How an expense is shared out, equally: each member's share is the amount divided by their number, rounded down, and
 * the remainder (less than their number) goes whole to the payer's share. So the shares add up to the amount exactly.
 * The shares are computed here, once, and kept with the expense as they were decided.
 */
export class Split {
  private constructor(readonly shares: Share[]) {}

  /** The members are the ones the expense is split between, in the order the payer gave, the payer among them. */
  static equally({ amount, payer, members }: { amount: Amount; payer: Id; members: Id[] }): IResult<Split> {
    if (new Set(members.map(member => member.value)).size !== members.length) {
      return Result.fail(new DuplicateSplitMember());
    }
    if (!members.some(member => member.value === payer.value)) return Result.fail(new PayerNotInSplit());

    const base = Math.floor(amount.value / members.length);
    const remainder = amount.value - base * members.length;
    return Result.ok(
      new Split(
        members.map(memberId => ({
          memberId,
          amount: memberId.value === payer.value ? base + remainder : base,
        })),
      ),
    );
  }

  /** The split as it was kept: shares given, never computed again. */
  static fromShares(shares: Share[]): Split {
    return new Split(shares);
  }
}
