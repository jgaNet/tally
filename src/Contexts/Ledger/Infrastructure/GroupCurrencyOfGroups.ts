import { IGroupQueries } from '@Contexts/Groups/Domain/IGroupQueries';
import { IGroupCurrency } from '@Contexts/Ledger/Application/IGroupCurrency';

/**
 * Answers Ledger's `IGroupCurrency` port over Groups' read model (CTX-CONTRACTS, ADR 18): the currency of a group, if the asking
 * account is one of its members. It is the one place Ledger reads a group's currency, through `groupOf` only; Ledger's Domain never
 * imports Groups. The wiring of this context gives it Groups' read side (`Contexts/Ledger/module.local.ts`).
 */
export class GroupCurrencyOfGroups implements IGroupCurrency {
  /** Groups' read model is given as a function, read when a currency is asked for and not when the modules are built (ADR 7). */
  constructor(private readonly groups: () => Pick<IGroupQueries, 'groupOf'>) {}

  async currencyOf(groupId: string, askedBy: string): Promise<string | undefined> {
    return (await this.groups().groupOf(groupId, askedBy))?.currency;
  }
}
