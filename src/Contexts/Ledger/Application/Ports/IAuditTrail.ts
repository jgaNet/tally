import { AuditAction } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';

/** One change of money, as the audit of its group keeps it. */
export interface AuditEntryDraft {
  id: string;
  groupId: string;
  at: Date;
  by: string;
  action: AuditAction;
  subjectId: string;
  amount: number;
}

/**
 * Ledger's own part of the audit (request 28): the expenses' changes. It is written inside the command's transaction, after the
 * change is saved, so a change has its entry or none. The id is the change's own: its action, its expense and the version it
 * was made from, so a change written twice is one entry.
 */
export interface IAuditTrail {
  record(entry: AuditEntryDraft): Promise<void>;
}
