import { Id, IResult, Result } from '@Architecture/Domain';

import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import {
  DuplicateSplitMember,
  InvalidShareAmount,
  InvalidShareCount,
  LedgerException,
  PayerNotInSplit,
  ShareAmountsDoNotAddUp,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** How an expense is shared out, as it is read: `equal`, `exact` or `shares`. */
export type SplitKind = 'equal' | 'exact' | 'shares';

/**
 * A split as it is asked for, by its kind: the members of an equal split, each member's exact amount, or each member's
 * shares. The ids are the members' account ids, as the caller gave them.
 */
export type SplitInput =
  | { kind: 'equal'; members: string[] }
  | { kind: 'exact'; amounts: { memberId: string; amount: number }[] }
  | { kind: 'shares'; shares: { memberId: string; shares: number }[] };

/** What one member of a split owes of an expense: whole, in the same unit as the amount. */
export interface Share {
  memberId: Id;
  amount: number;
}

/**
 * How an expense is shared out. Equally: each member's share is the amount divided by their number, rounded down. By
 * exact amounts: each member's share is the amount they were given, the amounts adding up to the expense's amount. By
 * shares: each member's share is the amount times their shares, divided by the total of the shares, rounded down. In
 * every kind the remainder, less than the number of members, goes whole to the payer's share, so the shares add up to the
 * amount exactly. The shares are computed here, once, and kept with the expense as they were decided.
 */
export class Split {
  private constructor(
    readonly kind: SplitKind,
    readonly shares: Share[],
  ) {}

  /** Decides the split an input asks for: the same refusals whichever kind it is, and the kind's own. */
  static decide({ amount, payer, input }: { amount: Amount; payer: Id; input: SplitInput }): IResult<Split> {
    switch (input.kind) {
      case 'equal':
        return Split.equally({ amount, payer, members: input.members.map(id => new Id(id)) });
      case 'exact':
        return Split.exactly({
          amount,
          payer,
          amounts: input.amounts.map(share => ({ memberId: new Id(share.memberId), amount: share.amount })),
        });
      case 'shares':
        return Split.byShares({
          amount,
          payer,
          shares: input.shares.map(share => ({ memberId: new Id(share.memberId), shares: share.shares })),
        });
    }
  }

  /** The members are the ones the expense is split between, in the order the payer gave, the payer among them. */
  static equally({ amount, payer, members }: { amount: Amount; payer: Id; members: Id[] }): IResult<Split> {
    const refusal = Split.membersRefusal(members, payer);
    if (refusal) return Result.fail(refusal);

    const base = Math.floor(amount.value / members.length);
    const remainder = amount.value - base * members.length;
    return Result.ok(
      new Split(
        'equal',
        members.map(memberId => ({
          memberId,
          amount: memberId.value === payer.value ? base + remainder : base,
        })),
      ),
    );
  }

  /** Each member is given their exact amount: 0 or more, whole, and the amounts add up to the expense's amount. */
  static exactly({
    amount,
    payer,
    amounts,
  }: {
    amount: Amount;
    payer: Id;
    amounts: { memberId: Id; amount: number }[];
  }): IResult<Split> {
    const refusal = Split.membersRefusal(
      amounts.map(share => share.memberId),
      payer,
    );
    if (refusal) return Result.fail(refusal);
    if (amounts.some(share => !Number.isSafeInteger(share.amount) || share.amount < 0)) {
      return Result.fail(new InvalidShareAmount());
    }
    // Every amount is a safe whole number, 0 or more: a sum that is not the amount is refused, however it rounds.
    const total = amounts.reduce((sum, share) => sum + share.amount, 0);
    if (total !== amount.value) return Result.fail(new ShareAmountsDoNotAddUp());

    return Result.ok(
      new Split(
        'exact',
        amounts.map(share => ({ memberId: share.memberId, amount: share.amount })),
      ),
    );
  }

  /**
   * Each member has a whole number of shares, at least 1. Their share is the amount times their shares, divided by the total
   * of the shares, rounded down (exact in whole numbers, so no rounding of the big products); the remainder goes whole to the
   * payer's share.
   */
  static byShares({
    amount,
    payer,
    shares,
  }: {
    amount: Amount;
    payer: Id;
    shares: { memberId: Id; shares: number }[];
  }): IResult<Split> {
    const refusal = Split.membersRefusal(
      shares.map(share => share.memberId),
      payer,
    );
    if (refusal) return Result.fail(refusal);
    if (shares.some(share => !Number.isSafeInteger(share.shares) || share.shares < 1)) {
      return Result.fail(new InvalidShareCount());
    }

    const total = shares.reduce((sum, share) => sum + BigInt(share.shares), 0n);
    const whole = BigInt(amount.value);
    const parts = shares.map(share => (whole * BigInt(share.shares)) / total);
    const remainder = whole - parts.reduce((sum, part) => sum + part, 0n);
    return Result.ok(
      new Split(
        'shares',
        shares.map((share, index) => ({
          memberId: share.memberId,
          amount: Number(parts[index] + (share.memberId.value === payer.value ? remainder : 0n)),
        })),
      ),
    );
  }

  /** The split as it was kept: shares given, never computed again. */
  static fromShares(kind: SplitKind, shares: Share[]): Split {
    return new Split(kind, shares);
  }

  /** Each member is listed once, and the payer is one of them. */
  private static membersRefusal(members: Id[], payer: Id): LedgerException | null {
    if (new Set(members.map(member => member.value)).size !== members.length) return new DuplicateSplitMember();
    if (!members.some(member => member.value === payer.value)) return new PayerNotInSplit();
    return null;
  }
}
