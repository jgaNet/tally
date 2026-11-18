import { IGroupRoster } from '@Contexts/Groups/Domain/Group/Ports/IGroupRoster';
import { IGroupCurrency } from '@Contexts/Ledger/Application/IGroupCurrency';

/**
 * The currency of a group, answered over Groups' roster (request 21, the storm's GroupCurrency): the same roster Ledger's members
 * are read from, so an expense in another currency is refused against the group's currency as Groups keeps it, and no domain
 * imports Groups.
 */
export class GroupCurrencyFromGroups implements IGroupCurrency {
  constructor(private readonly roster: IGroupRoster) {}

  currencyOf(groupId: string): Promise<string | undefined> {
    return this.roster.currencyOf(groupId);
  }
}
