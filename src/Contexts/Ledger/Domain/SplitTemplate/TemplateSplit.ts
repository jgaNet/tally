import { Id, IResult, Result } from '@Architecture/Domain';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { InvalidShares, MemberListedTwice } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { TemplateSplitShape } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';

/** One member of a template's split: the shares it has (1 for each member of an equal split, as `Split` divides it). */
export interface TemplateMember {
  readonly memberId: Id;
  readonly shares: number;
}

/**
 * A split saved in a template, as it was given (request 25): equally between its members (`between`), or by shares
 * (`shares`). Exact amounts are not a template's: they depend on an expense's amount. An equal split is held as the
 * shares of 1 each, which is how `Split` divides an equal split, so one form stores both kinds.
 */
export interface TemplateSplit {
  readonly kind: 'between' | 'shares';
  readonly members: readonly TemplateMember[];
}

/** The split a command gives a template: exactly one of the two fields, and at least one member. */
export interface TemplateSplitRequest {
  splitBetween?: readonly string[];
  splitByShares?: readonly { memberId: string; shares: number }[];
}

/**
 * The split of a template as a command gives it. None of the two fields, or both, is the wrong shape (TemplateSplitShape);
 * each member is listed once (MemberListedTwice) and has a whole number of shares, at least 1 (InvalidShares). Whether the
 * members are members of the group is the aggregate's to decide.
 */
export function templateSplitOf({ splitBetween, splitByShares }: TemplateSplitRequest): IResult<TemplateSplit> {
  if ((splitBetween === undefined) === (splitByShares === undefined)) return Result.fail(new TemplateSplitShape());

  if (splitBetween !== undefined) {
    if (splitBetween.length === 0) return Result.fail(new TemplateSplitShape());
    if (!listedOnce(splitBetween)) return Result.fail(new MemberListedTwice());
    return Result.ok({
      kind: 'between',
      members: splitBetween.map(member => ({ memberId: new Id(member), shares: 1 })),
    });
  }

  const shares = splitByShares ?? [];
  if (shares.length === 0) return Result.fail(new TemplateSplitShape());
  if (!listedOnce(shares.map(share => share.memberId))) return Result.fail(new MemberListedTwice());
  if (shares.some(share => !Number.isSafeInteger(share.shares) || share.shares < 1)) {
    return Result.fail(new InvalidShares());
  }
  return Result.ok({
    kind: 'shares',
    members: shares.map(share => ({ memberId: new Id(share.memberId), shares: share.shares })),
  });
}

/** The split a template gives an expense in place of its own (request 25): as if the split had been given, under the same rules. */
export function requestOfTemplateSplit(split: TemplateSplit): SplitRequest {
  if (split.kind === 'between') return { splitBetween: split.members.map(member => member.memberId.value) };
  return {
    splitByShares: split.members.map(member => ({ memberId: member.memberId.value, shares: member.shares })),
  };
}

function listedOnce(members: readonly string[]): boolean {
  return new Set(members).size === members.length;
}
