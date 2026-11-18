import { GroupAuditEntry } from '@Contexts/Groups/Domain/Group/GroupAudit';

/**
 * Groups' audit (feature 28, ADR 23): the entry of a balance that passed to the owner when a member left, written in the leave's transaction,
 * so a leave answered as done has its entry and a refused one has none. Read through Groups' roster (`IGroupRoster.auditOf`).
 */
export interface IGroupAuditLog {
  record(entry: GroupAuditEntry): Promise<void>;
}
