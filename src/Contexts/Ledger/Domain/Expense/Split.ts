import { Id, IResult, Result, ValueObject } from '@Architecture/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { SPLIT_KINDS, SplitKind, SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';
import {
  ExactAmountsDoNotAddUp,
  InvalidExactAmount,
  InvalidShares,
  MemberListedTwice,
  OneSplitOnly,
  PayerNotInSplit,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What one member of a split owes of an expense, whole. */
export interface Share {
  readonly memberId: Id;
  readonly amount: number;
}

interface SplitValue {
  readonly kind: SplitKind;
  readonly payer: Id;
  readonly shares: readonly Share[];
}

/**
 * How an expense is shared between the members it concerns: the payer, who is one of them, how it was split, and each
 * member's share in the order the split was given. Made once, when the expense is recorded or edited, and kept as it was
 * decided: the shares add up to the amount exactly. Whatever the kind, what a split leaves over goes whole to the payer.
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
    const listed = Split.membersListedOnce(payer, between);
    if (listed.isFailure()) return listed;
    return Split.divided(
      'equal',
      amount,
      payer,
      between.map(memberId => ({ memberId, weight: 1 })),
    );
  }

  /**
   * A split by exact amounts: each member with the amount of their share, 0 or more, which must add up to the expense's
   * amount exactly. The payer is one of the members, whatever their amount.
   */
  static exactly({
    amount,
    payer,
    amounts,
  }: {
    amount: Amount;
    payer: Id;
    amounts: readonly { memberId: Id; amount: number }[];
  }): IResult<Split> {
    const listed = Split.membersListedOnce(
      payer,
      amounts.map(share => share.memberId),
    );
    if (listed.isFailure()) return listed;
    if (amounts.some(share => !Number.isSafeInteger(share.amount) || share.amount < 0)) {
      return Result.fail(new InvalidExactAmount());
    }
    const total = amounts.reduce((sum, share) => sum + BigInt(share.amount), 0n);
    if (total !== BigInt(amount.value)) return Result.fail(new ExactAmountsDoNotAddUp());

    return Result.ok(
      new Split({
        kind: 'exact',
        payer,
        shares: amounts.map(share => ({ memberId: share.memberId, amount: share.amount })),
      }),
    );
  }

  /**
   * A split by shares: each member has a whole number of shares, at least 1. A member's share is the amount times their
   * shares, divided by the total of the shares, rounded down; the remainder goes whole to the payer's share, as in an
   * equal split. 1000 by shares of 1, 1 and 1 is the equal split of 1000.
   */
  static byShares({
    amount,
    payer,
    shares,
  }: {
    amount: Amount;
    payer: Id;
    shares: readonly { memberId: Id; shares: number }[];
  }): IResult<Split> {
    const listed = Split.membersListedOnce(
      payer,
      shares.map(share => share.memberId),
    );
    if (listed.isFailure()) return listed;
    if (shares.some(share => !Number.isSafeInteger(share.shares) || share.shares < 1)) {
      return Result.fail(new InvalidShares());
    }
    return Split.divided(
      'shares',
      amount,
      payer,
      shares.map(share => ({ memberId: share.memberId, weight: share.shares })),
    );
  }

  /**
   * The split a command gives, by the one of its three fields it names. None of them, or more than one, is refused by
   * name: the transport refuses that body first, as a shape.
   */
  static fromRequest({ amount, payer, request }: { amount: Amount; payer: Id; request: SplitRequest }): IResult<Split> {
    const given = [request.splitBetween, request.splitExactly, request.splitByShares].filter(
      field => field !== undefined,
    );
    if (given.length !== 1) return Result.fail(new OneSplitOnly());

    if (request.splitBetween !== undefined) {
      return Split.equally({ amount, payer, between: request.splitBetween.map(member => new Id(member)) });
    }
    if (request.splitExactly !== undefined) {
      return Split.exactly({
        amount,
        payer,
        amounts: request.splitExactly.map(share => ({ memberId: new Id(share.memberId), amount: share.amount })),
      });
    }
    return Split.byShares({
      amount,
      payer,
      shares: (request.splitByShares ?? []).map(share => ({ memberId: new Id(share.memberId), shares: share.shares })),
    });
  }

  /**
   * A split as it was stored. It records nothing, and refuses corrupted data by throwing: its kind must be one of the
   * three, its shares must add up to the expense's amount, and the payer must be one of them.
   */
  static fromSnapshot({
    kind,
    payer,
    shares,
    amount,
  }: {
    kind: SplitKind;
    payer: string;
    shares: readonly { memberId: string; amount: number }[];
    amount: number;
  }): Split {
    const total = shares.reduce((sum, share) => sum + share.amount, 0);
    const members = new Set(shares.map(share => share.memberId));
    if (
      !SPLIT_KINDS.includes(kind) ||
      total !== amount ||
      !members.has(payer) ||
      members.size !== shares.length ||
      shares.length === 0
    ) {
      throw new Error(`Corrupted split of ${payer}`);
    }
    return new Split({
      kind,
      payer: new Id(payer),
      shares: shares.map(share => ({ memberId: new Id(share.memberId), amount: share.amount })),
    });
  }

  /** The way the expense is split: `equal`, `exact` or `shares`. */
  get kind(): SplitKind {
    return this.value.kind;
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

  /** Every member listed once, the payer among them: the rule every kind of split shares. */
  private static membersListedOnce(payer: Id, members: readonly Id[]): IResult<void> {
    if (new Set(members.map(member => member.value)).size !== members.length) {
      return Result.fail(new MemberListedTwice());
    }
    if (!members.some(member => member.equals(payer))) return Result.fail(new PayerNotInSplit());
    return Result.ok();
  }

  /**
   * Divides the amount by the weights of the members: each share is the amount times its weight over the total of the
   * weights, rounded down (in whole numbers, without losing precision); what is left over goes whole to the payer.
   */
  private static divided(
    kind: SplitKind,
    amount: Amount,
    payer: Id,
    parts: readonly { memberId: Id; weight: number }[],
  ): IResult<Split> {
    const total = parts.reduce((sum, part) => sum + BigInt(part.weight), 0n);
    const floors = parts.map(part => Number((BigInt(amount.value) * BigInt(part.weight)) / total));
    const remainder = amount.value - floors.reduce((sum, share) => sum + share, 0);
    const shares = parts.map((part, index) => ({
      memberId: part.memberId,
      amount: floors[index] + (part.memberId.equals(payer) ? remainder : 0),
    }));
    return Result.ok(new Split({ kind, payer, shares }));
  }

  protected equalsValue(a: SplitValue, b: SplitValue): boolean {
    return (
      a.kind === b.kind &&
      a.payer.equals(b.payer) &&
      a.shares.length === b.shares.length &&
      a.shares.every(
        (share, index) => share.memberId.equals(b.shares[index].memberId) && share.amount === b.shares[index].amount,
      )
    );
  }
}
