import { IResult, Result } from '@Architecture/Domain';

import {
  InvalidSplitAmountException,
  InvalidSplitSharesException,
  PayerNotInSplitException,
  SplitAmountsDoNotAddUpException,
  SplitMemberListedTwiceException,
} from './ExpenseExceptions';
import { ExpenseAmount } from './ExpenseAmount';

/** One member's share of an expense, whole. */
export interface Share {
  readonly memberId: string;
  readonly amount: number;
}

/** How an expense was split: `equal`, by exact amounts (`exact`), or by whole shares (`shares`). */
export type SplitKind = 'equal' | 'exact' | 'shares';

/**
 * How an expense is asked to be split, the three ways (request 7): between members equally, each with the exact amount of
 * their share, or each with a whole number of shares. The members are listed in the order given.
 */
export type SplitRequest =
  | { readonly kind: 'equal'; readonly memberIds: readonly string[] }
  | { readonly kind: 'exact'; readonly amounts: readonly { readonly memberId: string; readonly amount: number }[] }
  | { readonly kind: 'shares'; readonly shares: readonly { readonly memberId: string; readonly shares: number }[] };

/** The members a split is between, in the order it lists them. */
export const memberIdsOfSplit = (request: SplitRequest): string[] =>
  request.kind === 'equal'
    ? [...request.memberIds]
    : request.kind === 'exact'
      ? request.amounts.map(line => line.memberId)
      : request.shares.map(line => line.memberId);

/**
 * How an expense is shared between its members, kept as it was decided (ADR 5, ADR 6). Each split keeps its kind and, per
 * member, the amount of their share, in the order the split was given. The shares add up to the amount exactly, by
 * construction, and the remainder of a split is whole and goes to the payer:
 * - equal: each share is the amount divided by the number of members, rounded down (the remainder to the payer);
 * - exact: each share is the amount the member was given, which the split checks adds up to the expense's amount;
 * - shares: each share is the amount times the member's shares, divided by the total of the shares, rounded down (the
 *   remainder to the payer). The shares themselves are not kept: a split is read as its amounts.
 */
export class Split {
  readonly #payer: string;
  readonly #kind: SplitKind;
  readonly #shares: Share[];

  private constructor(payer: string, kind: SplitKind, shares: Share[]) {
    this.#payer = payer;
    this.#kind = kind;
    this.#shares = shares;
  }

  /**
   * The split of `amount` as `request` asks it: each member listed once, the payer among them, and the amounts or shares
   * the request's kind allows. Refusals are named by their exception.
   */
  static create({
    amount,
    request,
    payer,
  }: {
    amount: ExpenseAmount;
    request: SplitRequest;
    payer: string;
  }): IResult<Split> {
    const memberIds = memberIdsOfSplit(request);
    if (new Set(memberIds).size !== memberIds.length) return Result.fail(new SplitMemberListedTwiceException());
    if (!memberIds.includes(payer)) return Result.fail(new PayerNotInSplitException());

    if (request.kind === 'equal') {
      return Result.ok(new Split(payer, 'equal', equalShares(amount.value, memberIds, payer)));
    }
    if (request.kind === 'exact') {
      const lines = request.amounts;
      if (lines.some(line => !Number.isSafeInteger(line.amount) || line.amount < 0)) {
        return Result.fail(new InvalidSplitAmountException());
      }
      const total = lines.reduce((sum, line) => sum + line.amount, 0);
      if (total !== amount.value) return Result.fail(new SplitAmountsDoNotAddUpException());
      return Result.ok(
        new Split(
          payer,
          'exact',
          lines.map(line => ({ memberId: line.memberId, amount: line.amount })),
        ),
      );
    }
    const lines = request.shares;
    if (lines.some(line => !Number.isSafeInteger(line.shares) || line.shares < 1)) {
      return Result.fail(new InvalidSplitSharesException());
    }
    return Result.ok(new Split(payer, 'shares', sharesOf(amount.value, lines, payer)));
  }

  /**
   * A split as it was stored, given its kind and the amounts it kept: it answers `undefined` when those amounts are not
   * one the kind could have given (the expense is then corrupted). A split by shares keeps its amounts only, so it is
   * checked for the amounts' shape: whole, 0 or more, adding up to the amount, with the payer among the members.
   */
  static restore({
    amount,
    payer,
    kind,
    shares,
  }: {
    amount: number;
    payer: string;
    kind: SplitKind;
    shares: readonly Share[];
  }): Split | undefined {
    const expenseAmount = ExpenseAmount.create(amount);
    if (expenseAmount.isFailure()) return undefined;
    const request: SplitRequest =
      kind === 'equal'
        ? { kind, memberIds: shares.map(share => share.memberId) }
        : { kind: 'exact', amounts: shares.map(share => ({ memberId: share.memberId, amount: share.amount })) };
    const split = Split.create({ amount: expenseAmount.data!, request, payer });
    if (split.isFailure()) return undefined;
    const sameAsStored = split.data!.shares.every(
      (share, i) => share.memberId === shares[i].memberId && share.amount === shares[i].amount,
    );
    if (!sameAsStored || shares.length !== split.data!.shares.length) return undefined;
    return kind === 'shares' ? new Split(payer, 'shares', [...shares]) : split.data;
  }

  get payer(): string {
    return this.#payer;
  }

  get kind(): SplitKind {
    return this.#kind;
  }

  get shares(): readonly Share[] {
    return [...this.#shares];
  }
}

/** The equal split: the amount divided by the members, rounded down, the remainder whole to the payer. */
function equalShares(amount: number, memberIds: readonly string[], payer: string): Share[] {
  const base = Math.floor(amount / memberIds.length);
  const remainder = amount - base * memberIds.length;
  return memberIds.map(memberId => ({ memberId, amount: memberId === payer ? base + remainder : base }));
}

/**
 * The split by shares: each member's amount is the amount times their shares over the total of the shares, rounded down,
 * computed exactly (in whole numbers of any size); what the rounding leaves over goes whole to the payer.
 */
function sharesOf(
  amount: number,
  lines: readonly { readonly memberId: string; readonly shares: number }[],
  payer: string,
): Share[] {
  const total = lines.reduce((sum, line) => sum + BigInt(line.shares), 0n);
  const shares = lines.map(line => ({
    memberId: line.memberId,
    amount: Number((BigInt(amount) * BigInt(line.shares)) / total),
  }));
  const remainder = amount - shares.reduce((sum, share) => sum + share.amount, 0);
  return shares.map(share => (share.memberId === payer ? { ...share, amount: share.amount + remainder } : share));
}
