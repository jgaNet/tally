import { Id } from '@Architecture/Domain';

/** The changes of money an audit records (request 28). */
export type AuditAction =
  | 'expense-recorded'
  | 'expense-edited'
  | 'expense-deleted'
  | 'settlement-paid'
  | 'settlement-refunded'
  | 'balance-passed';

/**
 * One entry of a group's audit (request 28): who made a change of money (`by`), when (`at`), what (`action`, about
 * `subjectId`) and how much (`amount`). An entry is never changed or removed. Each context writes the entries of its own
 * changes in the transaction of the change; Ledger reads them all.
 */
export interface AuditEntry {
  id: string;
  groupId: string;
  at: string;
  by: string;
  action: AuditAction;
  subjectId: string;
  amount: number;
}

/**
 * Makes the entry of a change, in the domain: its identity is generated here (DOMAIN-IDENTITY), and its time is the one the
 * caller's clock gave (DOMAIN-ONE-CLOCK). Records nothing else: the aggregate keeps the entry until its store writes it.
 */
export function recordAudit({
  groupId,
  at,
  by,
  action,
  subjectId,
  amount,
}: {
  groupId: string;
  at: Date;
  by: string;
  action: AuditAction;
  subjectId: string;
  amount: number;
}): AuditEntry {
  return { id: Id.generate().value, groupId, at: at.toISOString(), by, action, subjectId, amount };
}
