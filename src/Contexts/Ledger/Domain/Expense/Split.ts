import { IResult, Result } from '@Architecture/Domain';

import { PayerNotInSplitException, SplitMemberListedTwiceException } from './ExpenseExceptions';
import { ExpenseAmount } from './ExpenseAmount';

/** One member's share of an expense, whole. */
export interface Share {
  readonly memberId: string;
  readonly amount: number;
}

/**
 * How an expense is shared equally between its members, kept as it was decided (ADR 5): each share is the amount divided
 * by the number of members, rounded down, and the remainder, less than that number, goes whole to the payer. The shares
 * are kept in the order the split was given, and they add up to the amount exactly, by construction.
 */
export class Split {
  readonly #payer: string;
  readonly #shares: Share[];

  private constructor(payer: string, shares: Share[]) {
    this.#payer = payer;
    this.#shares = shares;
  }

  /** The split of `amount` between `memberIds`, in that order, the payer among them and each listed once. */
  static create({
    amount,
    memberIds,
    payer,
  }: {
    amount: ExpenseAmount;
    memberIds: readonly string[];
    payer: string;
  }): IResult<Split> {
    if (new Set(memberIds).size !== memberIds.length) return Result.fail(new SplitMemberListedTwiceException());
    if (!memberIds.includes(payer)) return Result.fail(new PayerNotInSplitException());

    const count = memberIds.length;
    const base = Math.floor(amount.value / count);
    const remainder = amount.value - base * count;
    const shares = memberIds.map(memberId => ({
      memberId,
      amount: memberId === payer ? base + remainder : base,
    }));
    return Result.ok(new Split(payer, shares));
  }

  get payer(): string {
    return this.#payer;
  }

  get shares(): readonly Share[] {
    return [...this.#shares];
  }
}
