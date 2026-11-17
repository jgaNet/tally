import { SettledAmountOf } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettledAmountsQueries';

/**
 * Settlements' own read of the payments waiting at the provider, as the change each member's waiting payments make to their balance
 * (positive for a payer, negative for a payee). The suggestions count them as paid (the storm's T11); the balances do not.
 */
export interface IPendingPayments {
  pendingEffectOf(groupId: string): Promise<SettledAmountOf[]>;
}
