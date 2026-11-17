import { IResult, Result, ValueObject } from '@Architecture/Domain';

import {
  DuplicateSplitMemberException,
  InvalidSplitAmountException,
  InvalidSplitSharesException,
  PayerNotInSplitException,
  SplitAmountsDoNotAddUpException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What one member of a split owes of an expense: whole units, the shares adding up to the amount exactly. */
export interface Share {
  readonly memberId: string;
  readonly amount: number;
}

/** How an expense is split (request 7): equally, by exact amounts, or by whole shares. Read as `equal`, `exact` or `shares`. */
export type SplitKind = 'equal' | 'exact' | 'shares';

/**
 * A split as a member gives it, before it is decided: the members of an equal split; each member with the exact amount of
 * their share; each member with a whole number of shares. The order given is the order kept.
 */
export type SplitDraft =
  | { readonly kind: 'equal'; readonly memberIds: readonly string[] }
  | { readonly kind: 'exact'; readonly amounts: readonly { readonly memberId: string; readonly amount: number }[] }
  | { readonly kind: 'shares'; readonly shares: readonly { readonly memberId: string; readonly shares: number }[] };

/** The members a draft names, in the order given. */
export const memberIdsOf = (draft: SplitDraft): string[] => {
  if (draft.kind === 'equal') return [...draft.memberIds];
  if (draft.kind === 'exact') return draft.amounts.map(entry => entry.memberId);
  return draft.shares.map(entry => entry.memberId);
};

interface SplitValue {
  readonly kind: SplitKind;
  readonly shares: readonly Share[];
}

/**
 * How an expense is shared between the members it names (conventions/domain.yaml, the storm's split). Three ways, one rule
 * for the remainder:
 *
 * - `equal`: each member's share is the amount divided by the number of members, rounded down (`shares` of 1 each);
 * - `exact`: each member's share is the exact amount given, 0 or more, and they add up to the amount exactly;
 * - `shares`: each member's share is the amount times their shares, divided by the total of the shares, rounded down.
 *
 * In the two divisions what is left over, less than the number of members, goes whole to the payer's share, so the shares
 * always add up to the amount. The division is exact (BigInt), never a floating point one. Built through `decide()`, which
 * refuses a member listed twice, a split without its payer, amounts that do not add up, and shares below 1, so a `Split`
 * always holds shares the domain accepts. Its shares are kept with the expense as they were decided and never computed
 * again at a read.
 */
export class Split extends ValueObject<SplitValue> {
  private constructor(value: SplitValue) {
    super(value);
  }

  /** A split decided from what a member gave, for an expense of `amount` paid by `payerId`. Records nothing, reads nothing. */
  static decide({ amount, payerId, split }: { amount: number; payerId: string; split: SplitDraft }): IResult<Split> {
    const memberIds = memberIdsOf(split);
    if (new Set(memberIds).size !== memberIds.length) return Result.fail(new DuplicateSplitMemberException());
    if (!memberIds.includes(payerId)) return Result.fail(new PayerNotInSplitException());

    if (split.kind === 'equal') {
      const parts = split.memberIds.map(memberId => ({ memberId, weight: 1n }));
      return Result.ok(new Split({ kind: 'equal', shares: byWeights(BigInt(amount), payerId, parts) }));
    }

    if (split.kind === 'exact') {
      if (!split.amounts.every(entry => isWholeAmount(entry.amount))) {
        return Result.fail(new InvalidSplitAmountException());
      }
      const total = split.amounts.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
      if (total !== BigInt(amount)) return Result.fail(new SplitAmountsDoNotAddUpException());
      return Result.ok(
        new Split({
          kind: 'exact',
          shares: split.amounts.map(entry => ({ memberId: entry.memberId, amount: entry.amount })),
        }),
      );
    }

    if (!split.shares.every(entry => isWholeShares(entry.shares)))
      return Result.fail(new InvalidSplitSharesException());
    const parts = split.shares.map(entry => ({ memberId: entry.memberId, weight: BigInt(entry.shares) }));
    return Result.ok(new Split({ kind: 'shares', shares: byWeights(BigInt(amount), payerId, parts) }));
  }

  /**
   * A split as the store keeps it: its kind and its shares as they were decided, in their order, never computed again. Records
   * nothing, and throws on shares the domain never keeps (an unknown kind, a member twice, the payer missing, shares that do
   * not add up to the amount).
   */
  static kept({
    kind,
    amount,
    payerId,
    shares,
  }: {
    kind: SplitKind;
    amount: number;
    payerId: string;
    shares: readonly Share[];
  }): Split {
    const memberIds = shares.map(share => share.memberId);
    const total = shares.reduce((sum, share) => sum + share.amount, 0);
    if (
      !['equal', 'exact', 'shares'].includes(kind) ||
      memberIds.length === 0 ||
      new Set(memberIds).size !== memberIds.length ||
      !memberIds.includes(payerId) ||
      total !== amount
    ) {
      throw new Error(`The shares of an expense of ${amount} paid by ${payerId} are corrupted`);
    }
    return new Split({ kind, shares: shares.map(share => ({ ...share })) });
  }

  /** How the split was decided: `equal`, `exact` or `shares`. */
  get kind(): SplitKind {
    return this.value.kind;
  }

  /** The shares, in the order the split was given. A copy: the value keeps its own list. */
  get shares(): Share[] {
    return this.value.shares.map(share => ({ ...share }));
  }

  protected override equalsValue(a: SplitValue, b: SplitValue): boolean {
    return (
      a.kind === b.kind &&
      a.shares.length === b.shares.length &&
      a.shares.every((share, i) => share.memberId === b.shares[i].memberId && share.amount === b.shares[i].amount)
    );
  }
}

/**
 * Divides `amount` by the weights of the parts, each part getting its weight's share rounded down, and gives what is left
 * over to the payer. Every weight is at least 1, so the total is never 0.
 */
const byWeights = (amount: bigint, payerId: string, parts: { memberId: string; weight: bigint }[]): Share[] => {
  const total = parts.reduce((sum, part) => sum + part.weight, 0n);
  const rounded = parts.map(part => ({ memberId: part.memberId, amount: (amount * part.weight) / total }));
  const remainder = amount - rounded.reduce((sum, part) => sum + part.amount, 0n);
  return rounded.map(part => ({
    memberId: part.memberId,
    amount: Number(part.memberId === payerId ? part.amount + remainder : part.amount),
  }));
};

/** An exact amount is a whole number of 0 or more, and fits in the numbers the domain keeps. */
const isWholeAmount = (raw: number): boolean => Number.isSafeInteger(raw) && raw >= 0;

/** A member's shares are a whole number of 1 or more. */
const isWholeShares = (raw: number): boolean => Number.isSafeInteger(raw) && raw >= 1;
