import { IResult, Result, ValueObject } from '@Architecture/Domain';

import {
  DuplicateSplitMemberException,
  PayerNotInSplitException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What one member of a split owes of an expense: whole units, the shares adding up to the amount exactly. */
export interface Share {
  readonly memberId: string;
  readonly amount: number;
}

/**
 * How an expense is shared equally between the members it names (conventions/domain.yaml, the storm's split): each share is
 * the amount divided by the number of members, rounded down; what that leaves over, less than the number of members, goes
 * whole to the payer's share. So the shares always add up to the amount. Built through `equally()`, which refuses a member
 * listed twice and a split without its payer, so a `Split` always holds shares the domain accepts. Its shares are kept with
 * the expense as they were decided and never computed again at a read.
 */
export class Split extends ValueObject<readonly Share[]> {
  private constructor(shares: readonly Share[]) {
    super(shares);
  }

  static equally({
    amount,
    payerId,
    memberIds,
  }: {
    amount: number;
    payerId: string;
    memberIds: readonly string[];
  }): IResult<Split> {
    if (new Set(memberIds).size !== memberIds.length) return Result.fail(new DuplicateSplitMemberException());
    if (!memberIds.includes(payerId)) return Result.fail(new PayerNotInSplitException());

    const each = Math.floor(amount / memberIds.length);
    const remainder = amount - each * memberIds.length;
    return Result.ok(
      new Split(
        memberIds.map(memberId => ({
          memberId,
          amount: memberId === payerId ? each + remainder : each,
        })),
      ),
    );
  }

  /**
   * A split as the store keeps it: its shares as they were decided, in their order, never computed again. Records nothing,
   * and throws on shares the domain never keeps (a member twice, the payer missing, shares that do not add up to the amount).
   */
  static kept({ amount, payerId, shares }: { amount: number; payerId: string; shares: readonly Share[] }): Split {
    const memberIds = shares.map(share => share.memberId);
    const total = shares.reduce((sum, share) => sum + share.amount, 0);
    if (
      memberIds.length === 0 ||
      new Set(memberIds).size !== memberIds.length ||
      !memberIds.includes(payerId) ||
      total !== amount
    ) {
      throw new Error(`The shares of an expense of ${amount} paid by ${payerId} are corrupted`);
    }
    return new Split(shares.map(share => ({ ...share })));
  }

  /** The shares, in the order the split was given. A copy: the value keeps its own list. */
  get shares(): Share[] {
    return this.value.map(share => ({ ...share }));
  }

  protected override equalsValue(a: readonly Share[], b: readonly Share[]): boolean {
    return (
      a.length === b.length && a.every((share, i) => share.memberId === b[i].memberId && share.amount === b[i].amount)
    );
  }
}
