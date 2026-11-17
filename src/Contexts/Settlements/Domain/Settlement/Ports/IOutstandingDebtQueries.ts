import { OutstandingDebt } from '@Contexts/Settlements/Domain/Settlement/DTOs';

/**
 * What every member of every group still owes, read in one pass (request 18, docs/adr/0018): the balances as Ledger keeps them, less
 * the payments waiting at the provider, which count as paid until the provider says otherwise. Read by Notifications' sweep through its
 * own port, `OutstandingDebts`, and answered by an adapter in Settlements' Infrastructure over the balances and Settlements' read model.
 */
export interface IOutstandingDebtQueries {
  /** Every member who still owes something, in every group; a member who owes nothing, or is owed, is not listed. */
  outstandingDebts(): Promise<OutstandingDebt[]>;
}
