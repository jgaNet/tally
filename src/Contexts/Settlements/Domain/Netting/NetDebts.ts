import { Id, IResult, Result } from '@Architecture/Domain';

import { NothingToNet } from '@Contexts/Settlements/Domain/Netting/NettingExceptions';

/**
 * A group the two people share, in the currency, as the netting reads it: each one's balance there, as the book counts it (what
 * waits at the provider already counted as paid). A negative balance is a debt, in the group's money.
 */
export interface SharedGroup {
  readonly groupId: Id;
  readonly callerBalance: number;
  readonly otherBalance: number;
}

/** A settlement the netting makes in one group: `payer` pays `payee` the amount there. */
export interface PlannedSettlement {
  readonly groupId: Id;
  readonly payer: Id;
  readonly payee: Id;
  readonly amount: number;
}

/** What a netting makes: the amount netted, and its settlements in the order they are made (the caller's payments, then the other's). */
export interface NettingPlan {
  readonly amount: number;
  readonly settlements: PlannedSettlement[];
}

/**
 * The domain service that nets what two people owe each other across the groups they share (request 32, the storm's T2). In each
 * group, what the caller can pay the other is the smaller of what the caller owes and what the other is owed, when the caller owes and
 * the other is owed; the same, the other way round, for what the other can pay the caller. The amount netted is the smaller of the two
 * totals. Each side pays that amount group by group, in the order the groups were created, the earliest first, each group paying the
 * smaller of what is left to net and what that side can pay there. When the amount is not at least 1, nothing is netted: NothingToNet.
 */
export class NetDebts {
  static plan({ by, withAccount, groups }: { by: Id; withAccount: Id; groups: SharedGroup[] }): IResult<NettingPlan> {
    const callerCanPay = groups.map(group => payable(group.callerBalance, group.otherBalance));
    const otherCanPay = groups.map(group => payable(group.otherBalance, group.callerBalance));
    const amount = Math.min(sum(callerCanPay), sum(otherCanPay));
    if (amount < 1) return Result.fail(new NothingToNet());

    return Result.ok({
      amount,
      settlements: [
        ...spread(groups, callerCanPay, amount, by, withAccount),
        ...spread(groups, otherCanPay, amount, withAccount, by),
      ],
    });
  }
}

/** What a member who owes `owes` can pay a member who is owed `isOwed`, in one group: nothing unless the first owes and the second is owed. */
const payable = (owes: number, isOwed: number): number => (owes < 0 && isOwed > 0 ? Math.min(-owes, isOwed) : 0);

const sum = (amounts: number[]): number => amounts.reduce((total, amount) => total + amount, 0);

/** Pays `amount` from `payer` to `payee`, group by group in the order given, each group paying the smaller of what is left and what it can pay. */
const spread = (groups: SharedGroup[], canPay: number[], amount: number, payer: Id, payee: Id): PlannedSettlement[] => {
  let left = amount;
  const settlements: PlannedSettlement[] = [];
  groups.forEach((group, index) => {
    const pay = Math.min(left, canPay[index]);
    if (pay < 1) return;
    settlements.push({ groupId: group.groupId, payer, payee, amount: pay });
    left -= pay;
  });
  return settlements;
};
