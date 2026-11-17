import { OutstandingDebt } from '@Contexts/Notifications/Domain/DebtWatch/DTOs';

/**
 * Notifications' own port onto Settlements (ADR 10, T9): what each current member of each group still owes, counted as
 * Settlements counts it, with the payments waiting at the provider as paid. The sweep asks it when it runs; the adapter answers
 * over Settlements' read model. No domain imports Settlements.
 */
export interface IOutstandingDebts {
  owing(): Promise<OutstandingDebt[]>;
}
