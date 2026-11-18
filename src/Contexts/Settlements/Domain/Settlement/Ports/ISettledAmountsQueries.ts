/** What has been settled for one member of a group: the change the group's settlements make to the member's balance. */
export interface SettledAmountOf {
  memberId: string;
  /** Positive for a payer (their balance goes up by what they paid), negative for a payee (it goes down). */
  amount: number;
}

/**
 * One settlement the balances count, as a member's statement lists it (request 29): what it is, who paid whom, how much, and when
 * the balances started to count it, as an ISO instant.
 */
export interface CountedSettlementOf {
  settlementId: string;
  method: 'cash' | 'provider';
  payer: string;
  payee: string;
  amount: number;
  /** The instant the balances started to count it: its recording for a cash settlement, the moment it was first paid otherwise. */
  countedFrom: string;
}

/**
 * The read-model port another context reads what has been settled through (ADR 7): one row per member with a settlement in
 * the group, the sum of the settlements' effect on their balance. Read by Ledger when it reads a balance, inside the command's
 * transaction or outside it, so it takes no lock of its own.
 *
 * `countedOf` answers each settlement a member pays or receives that the balances count, with when they started to count it
 * (ADR 20): read by Ledger's statement, the same reads of the same table.
 */
export interface ISettledAmountsQueries {
  settledOf(groupId: string): Promise<SettledAmountOf[]>;
  countedOf(groupId: string, memberId: string): Promise<CountedSettlementOf[]>;
}
