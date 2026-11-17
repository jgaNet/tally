import { IResult, Result } from '@Architecture/Domain';

import { ShareSnapshot, SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';
import {
  DuplicateInSplitException,
  InvalidSharesException,
  InvalidSplitAmountException,
  NotAMemberInSplitException,
  PayerNotInSplitException,
  SplitDoesNotAddUpException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The kinds a split may be, as the store keeps them (request 7). */
export const SPLIT_KINDS: readonly SplitKind[] = ['equal', 'exact', 'shares'];

/**
 * How an expense is shared, as the caller gives it (the storm, hot spots 1 and 2; requests 4 and 7). Exactly one of the three
 * is given: the transport says so by the body's shape; the domain checks what each one says.
 *
 * - `equal`: the members the amount is split between, equally;
 * - `exact`: each member with the exact amount of their share, the amounts adding up to the expense's amount;
 * - `shares`: each member with a whole number of shares, the amount divided by their shares in proportion.
 */
export type SplitInput =
  | { kind: 'equal'; between: string[] }
  | { kind: 'exact'; amounts: Array<{ memberId: string; amount: number }> }
  | { kind: 'shares'; shares: Array<{ memberId: string; shares: number }> };

/**
 * How an expense's amount is shared between the members it concerns (the storm, hot spot 3). Each member's share is the
 * amount times their weight over the total of the weights, rounded down (an equal split weighs every member 1, a split by
 * shares weighs them by their shares); what is left over, less than the total of the weights, goes whole to the member listed
 * first in the split, whoever paid (request 10). The shares add up to the amount exactly, and they are kept in the order the
 * split was given. The arithmetic is exact
 * (BigInt), so no amount or number of shares rounds on the way.
 *
 * `of()` refuses a split a member is listed twice in, one with someone who is not a current member, one without its
 * payer, one whose exact amounts do not add up or are not whole and 0 or more, and one whose shares are not whole and 1 or
 * more. `fromSnapshot()` reads the shares the store kept; the expense checks that they add up.
 */
export class Split {
  readonly #kind: SplitKind;
  readonly #shares: ShareSnapshot[];

  private constructor(kind: SplitKind, shares: ShareSnapshot[]) {
    this.#kind = kind;
    this.#shares = shares;
  }

  static of({
    input,
    amount,
    payerId,
    members,
  }: {
    input: SplitInput;
    amount: number;
    payerId: string;
    members: string[];
  }): IResult<Split> {
    const listed = listedMembers(input);
    if (new Set(listed).size !== listed.length) {
      return Result.fail(new DuplicateInSplitException());
    }
    const currentMembers = new Set(members);
    if (listed.some(memberId => !currentMembers.has(memberId))) {
      return Result.fail(new NotAMemberInSplitException());
    }
    if (!listed.includes(payerId)) {
      return Result.fail(new PayerNotInSplitException());
    }

    switch (input.kind) {
      case 'equal':
        return Result.ok(
          weighted(
            'equal',
            amount,
            input.between.map(memberId => ({ memberId, weight: 1n })),
          ),
        );
      case 'exact': {
        if (input.amounts.some(({ amount: share }) => !Number.isInteger(share) || share < 0)) {
          return Result.fail(new InvalidSplitAmountException());
        }
        const total = input.amounts.reduce((sum, { amount: share }) => sum + BigInt(share), 0n);
        if (total !== BigInt(amount)) {
          return Result.fail(new SplitDoesNotAddUpException());
        }
        return Result.ok(
          new Split(
            'exact',
            input.amounts.map(({ memberId, amount: share }) => ({ memberId, amount: share })),
          ),
        );
      }
      case 'shares': {
        if (input.shares.some(({ shares }) => !Number.isInteger(shares) || shares < 1)) {
          return Result.fail(new InvalidSharesException());
        }
        return Result.ok(
          weighted(
            'shares',
            amount,
            input.shares.map(({ memberId, shares }) => ({ memberId, weight: BigInt(shares) })),
          ),
        );
      }
    }
  }

  static fromSnapshot({ kind, shares }: { kind: SplitKind; shares: ShareSnapshot[] }): Split {
    return new Split(
      kind,
      shares.map(share => ({ ...share })),
    );
  }

  get kind(): SplitKind {
    return this.#kind;
  }

  get shares(): ShareSnapshot[] {
    return this.#shares.map(share => ({ ...share }));
  }

  get total(): number {
    return this.#shares.reduce((sum, share) => sum + share.amount, 0);
  }
}

/** The members a split names, each as many times as it is listed. */
function listedMembers(input: SplitInput): string[] {
  switch (input.kind) {
    case 'equal':
      return input.between;
    case 'exact':
      return input.amounts.map(({ memberId }) => memberId);
    case 'shares':
      return input.shares.map(({ memberId }) => memberId);
  }
}

/**
 * Each member's share is the amount times their weight over the total of the weights, rounded down; the remainder goes whole
 * to the member listed first (request 10). The amount is at most MAX_EXPENSE_AMOUNT, checked before the split is made, and the
 * weights are whole and positive, so every share is whole and the remainder is less than the number of members or of shares.
 * Expenses recorded before request 10 keep the shares they were given: they are never computed again.
 */
function weighted(kind: SplitKind, amount: number, parts: Array<{ memberId: string; weight: bigint }>): Split {
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0n);
  const shares = parts.map(({ memberId, weight }) => ({
    memberId,
    amount: Number((BigInt(amount) * weight) / totalWeight),
  }));
  const remainder = amount - shares.reduce((sum, share) => sum + share.amount, 0);
  shares[0].amount += remainder;
  return Split.fromSnapshot({ kind, shares });
}
