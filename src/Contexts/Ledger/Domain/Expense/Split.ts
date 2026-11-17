/** One member's share of an expense, whole, in the amount's unit. */
export interface ExpenseShare {
  memberId: string;
  amount: number;
}

/**
 * An equal split: the amount divided by the number of members, each share rounded down, and the remainder (less than
 * the number of members) given whole to the payer. The shares add up to the amount exactly, and come in the order the
 * members were given. A value: computed once, when the expense is made, and kept with it.
 *
 * Its caller decides who may be in the split (the Expense does); this only divides.
 */
export class Split {
  static equally({
    amount,
    memberIds,
    payerId,
  }: {
    amount: number;
    memberIds: string[];
    payerId: string;
  }): ExpenseShare[] {
    const base = Math.floor(amount / memberIds.length);
    const remainder = amount - base * memberIds.length;
    return memberIds.map(memberId => ({
      memberId,
      amount: memberId === payerId ? base + remainder : base,
    }));
  }
}
