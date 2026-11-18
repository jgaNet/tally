import { IPassedBalances } from '@Contexts/Ledger/Application/Ports/IPassedBalances';
import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';
import { IPassedBalanceEntries } from '@Contexts/Groups/Domain/Group/Ports/IPassedBalanceEntries';

/**
 * Ledger's PassedBalances, answered over Groups' read side (request 28): each balance that passed to the owner when a member
 * left, as an entry of the audit. A balance of 0 changed no money, so it is no entry. The id is the key the balance was born with,
 * its group and its position there, which a leave takes once and a merge keeps (request 31).
 */
export class GroupsPassedBalances implements IPassedBalances {
  constructor(private readonly passed: IPassedBalanceEntries) {}

  async entriesOf(groupId: string): Promise<AuditEntryReadModel[]> {
    const balances = await this.passed.entriesOf(groupId);
    return balances
      .filter(balance => balance.amount !== 0)
      .map((balance): AuditEntryReadModel => ({
        id: `balance-passed:${balance.key}`,
        at: balance.at,
        by: balance.by,
        action: 'balance-passed',
        subjectId: balance.by,
        amount: balance.amount,
      }));
  }
}
