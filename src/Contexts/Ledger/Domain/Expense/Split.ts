import { IResult, Result } from '@Architecture/Domain';

import {
  InvalidSplitAmountException,
  InvalidSharesException,
  SplitAmountsDoNotAddUpException,
  SplitListsTwiceException,
  SplitWithStrangerException,
  SplitWithoutPayerException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** One member's share of an expense, whole, in the amount's unit. */
export interface ExpenseShare {
  memberId: string;
  amount: number;
}

/** How an expense is split: equally, by exact amounts, or by whole shares. Read back as `splitKind`. */
export type SplitKind = 'equal' | 'exact' | 'shares';

/** How a split was asked for: the members equally, each with an exact amount, or each with a whole number of shares. */
export type SplitRequest =
  | { kind: 'equal'; memberIds: string[] }
  | { kind: 'exact'; amounts: { memberId: string; amount: number }[] }
  | { kind: 'shares'; shares: { memberId: string; shares: number }[] };

/**
 * How an expense is divided between the members of its split. A value: computed once, when the expense is made, and
 * kept with it, in the order the members were given.
 *
 * - equal: the amount divided by the number of members, each share rounded down;
 * - exact: each member's amount, 0 or more, which must add up to the amount exactly;
 * - shares: each member's shares, at least 1 each; a member's share is the amount times their shares, divided by the
 *   total of the shares, rounded down.
 *
 * In the equal and the shares kinds, what the rounding leaves over (less than the number of members) goes whole to the
 * share of the member listed first in the split, whoever paid, so the shares add up to the amount exactly. An exact
 * split has no remainder. The members themselves (who may be in a split, the payer among them) are checked by `decide`,
 * the same way for every kind.
 */
export class Split {
  /**
   * An equal split: the amount divided between the members, the remainder to the first member listed. Its caller checks
   * the members, and that there is at least one.
   */
  static equally({ amount, memberIds }: { amount: number; memberIds: string[] }): ExpenseShare[] {
    const base = Math.floor(amount / memberIds.length);
    const remainder = amount - base * memberIds.length;
    return memberIds.map((memberId, index) => ({
      memberId,
      amount: index === 0 ? base + remainder : base,
    }));
  }

  /**
   * The shares of a split as it was asked for, checked and computed: the members are checked first (each a member of the
   * group, each once, the payer among them), then the values of the kind. A refusal is a failed Result, by name.
   */
  static decide({
    request,
    amount,
    payerId,
    memberIds,
  }: {
    request: SplitRequest;
    amount: number;
    payerId: string;
    memberIds: string[];
  }): IResult<ExpenseShare[]> {
    const listed = membersListedBy(request);
    if (listed.some(memberId => !memberIds.includes(memberId))) return Result.fail(new SplitWithStrangerException());
    if (new Set(listed).size !== listed.length) return Result.fail(new SplitListsTwiceException());
    if (!listed.includes(payerId)) return Result.fail(new SplitWithoutPayerException());

    switch (request.kind) {
      case 'equal':
        return Result.ok(Split.equally({ amount, memberIds: request.memberIds }));
      case 'exact':
        return Split.exact({ amount, amounts: request.amounts });
      case 'shares':
        return Split.byShares({ amount, shares: request.shares });
    }
  }

  /** Exact amounts: each 0 or more and whole, and together exactly the amount. */
  private static exact({
    amount,
    amounts,
  }: {
    amount: number;
    amounts: { memberId: string; amount: number }[];
  }): IResult<ExpenseShare[]> {
    if (amounts.some(share => !Number.isSafeInteger(share.amount) || share.amount < 0)) {
      return Result.fail(new InvalidSplitAmountException());
    }
    const total = amounts.reduce((sum, share) => sum + share.amount, 0);
    if (total !== amount) return Result.fail(new SplitAmountsDoNotAddUpException());

    return Result.ok(amounts.map(share => ({ memberId: share.memberId, amount: share.amount })));
  }

  /**
   * Shares: each at least 1 and whole. The total is computed in BigInt, so that no product or sum loses precision. The
   * first member listed takes what the rounding leaves over.
   */
  private static byShares({
    amount,
    shares,
  }: {
    amount: number;
    shares: { memberId: string; shares: number }[];
  }): IResult<ExpenseShare[]> {
    if (shares.some(share => !Number.isSafeInteger(share.shares) || share.shares < 1)) {
      return Result.fail(new InvalidSharesException());
    }
    const total = shares.reduce((sum, share) => sum + BigInt(share.shares), 0n);
    const bases = shares.map(share => ({
      memberId: share.memberId,
      amount: Number((BigInt(amount) * BigInt(share.shares)) / total),
    }));
    const remainder = amount - bases.reduce((sum, share) => sum + share.amount, 0);

    return Result.ok(
      bases.map((share, index) => ({
        memberId: share.memberId,
        amount: index === 0 ? share.amount + remainder : share.amount,
      })),
    );
  }
}

/** The members a split lists, in the order given. */
const membersListedBy = (request: SplitRequest): string[] => {
  switch (request.kind) {
    case 'equal':
      return request.memberIds;
    case 'exact':
      return request.amounts.map(share => share.memberId);
    case 'shares':
      return request.shares.map(share => share.memberId);
  }
};
