/**
 * What the settlements waiting at the payment provider do to each member's balance, read from Settlements' own record
 * (ADR 8): a payer's effect is what they are waiting to pay, a payee's is minus what is waiting to be paid to them. A
 * pending payment counts as paid for what is still owed (the suggestions read it with the balances), and the balances
 * count it only once it is paid. Settlements owns the answer; a member with none is absent from the map (0).
 */
export interface IWaitingEffects {
  effectsOf(groupId: string): Promise<Map<string, number>>;
}
