import { Id, IResult, Result, ValueObject } from '@Architecture/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { MemberListedTwice, PayerNotInSplit } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What one member of a split owes of an expense, whole. */
export interface Share {
  readonly memberId: Id;
  readonly amount: number;
}

interface SplitValue {
  readonly payer: Id;
  readonly shares: readonly Share[];
}

/**
 * How an expense is shared between the members it concerns: the payer, who is one of them, and each member's share in
 * the order the split was given. Made once, when the expense is recorded, and kept as it was decided: the shares add up
 * to the amount exactly, since the remainder of an equal split goes whole to the payer.
 */
export class Split extends ValueObject<SplitValue> {
  private constructor(value: SplitValue) {
    super(value);
  }

  /**
   * An equal split: each share is the amount divided by the number of members, rounded down; what that leaves over
   * (less than one share per member) goes whole to the payer's share.
   */
  static equally({ amount, payer, between }: { amount: Amount; payer: Id; between: readonly Id[] }): IResult<Split> {
    if (new Set(between.map(member => member.value)).size !== between.length) {
      return Result.fail(new MemberListedTwice());
    }
    if (!between.some(member => member.equals(payer))) return Result.fail(new PayerNotInSplit());

    const share = Math.floor(amount.value / between.length);
    const remainder = amount.value - share * between.length;
    const shares = between.map(memberId => ({
      memberId,
      amount: memberId.equals(payer) ? share + remainder : share,
    }));
    return Result.ok(new Split({ payer, shares }));
  }

  /**
   * A split as it was stored. It records nothing, and refuses corrupted data by throwing: its shares must add up to
   * the expense's amount, and the payer must be one of them.
   */
  static fromSnapshot({
    payer,
    shares,
    amount,
  }: {
    payer: string;
    shares: readonly { memberId: string; amount: number }[];
    amount: number;
  }): Split {
    const total = shares.reduce((sum, share) => sum + share.amount, 0);
    const members = new Set(shares.map(share => share.memberId));
    if (total !== amount || !members.has(payer) || members.size !== shares.length || shares.length === 0) {
      throw new Error(`Corrupted split of ${payer}`);
    }
    return new Split({
      payer: new Id(payer),
      shares: shares.map(share => ({ memberId: new Id(share.memberId), amount: share.amount })),
    });
  }

  get payer(): Id {
    return this.value.payer;
  }

  get shares(): readonly Share[] {
    return this.value.shares;
  }

  get memberIds(): Id[] {
    return this.value.shares.map(share => share.memberId);
  }

  protected equalsValue(a: SplitValue, b: SplitValue): boolean {
    return (
      a.payer.equals(b.payer) &&
      a.shares.length === b.shares.length &&
      a.shares.every(
        (share, index) => share.memberId.equals(b.shares[index].memberId) && share.amount === b.shares[index].amount,
      )
    );
  }
}
