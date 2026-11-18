import { CurrencyCode } from '@SharedKernel/Domain/Currency';

/**
 * Ledger's port to Groups, which it owns (ADR 12): the currency a group counts in, fixed when it was created. An expense paid in
 * another currency is converted into it, so the group's currency is read when the expense decides. Answered by an adapter over
 * Groups' read model; null when there is no such group.
 */
export interface IGroupCurrency {
  /** The group's currency, read by a command deciding an expense, inside its own transaction (it never changes, so no lock). */
  currencyOf(groupId: string): Promise<CurrencyCode | null>;
}
