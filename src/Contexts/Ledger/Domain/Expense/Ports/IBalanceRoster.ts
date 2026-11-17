/**
 * The balances of a group's members, as Ledger's read model gives them (ADR 1, T4 and T5): what each member owes or is owed, in
 * the group's currency's hundredths, read from the balance rows the expenses wrote. It answers a member nothing has counted 0.
 * It is the read-model port Groups reads through an adapter of its own, when a member asks to leave a group (feature 9): no
 * domain imports another context.
 */
export interface IBalanceRoster {
  balanceOf(groupId: string, memberId: string): Promise<number>;
}
