import { BalancePassedEntry } from '@Contexts/Groups/Domain/Group/Ports/IGroupAuditQueries';

/**
 * Groups' own audit of the balances passed when members left (request 28), written in the transaction of the leave, so the entry
 * is there when the leave is answered.
 */
export interface IGroupAuditLog {
  record(groupId: string, entry: BalancePassedEntry): Promise<void>;
}
