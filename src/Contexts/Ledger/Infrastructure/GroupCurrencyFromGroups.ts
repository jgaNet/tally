import { CurrencyCode, isCurrencyCode } from '@SharedKernel/Domain/Currency';

import { IGroupMembersQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembersQueries';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';

/**
 * Ledger's port to Groups, answered over Groups' read model (ADR 12): the group's currency, as the read model gives it. It is
 * a function, read when the port is asked, for the same reason as GroupMembersFromGroups (ADR 4).
 */
export class GroupCurrencyFromGroups implements IGroupCurrency {
  constructor(private groups: () => IGroupMembersQueries) {}

  async currencyOf(groupId: string): Promise<CurrencyCode | null> {
    const currency = await this.groups().currencyOf(groupId);
    return currency !== null && isCurrencyCode(currency) ? currency : null;
  }
}
