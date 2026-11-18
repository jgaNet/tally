import { Id } from '@Architecture/Domain';

/** The changes of money Settlements writes to the audit (request 28): a settlement the balances start to count, or no longer count. */
export type SettlementAuditAction = 'settlement-paid' | 'settlement-refunded' | 'settlement-contested';

/**
 * One entry of a group's audit, for a change of money a settlement made (request 28): who made it (`by`), when (`at`), what
 * (`action`, about the settlement `subjectId`) and how much (`amount`). Written in the transaction of the change, never changed.
 */
export interface AuditEntry {
  id: string;
  groupId: string;
  at: string;
  by: string;
  action: SettlementAuditAction;
  subjectId: string;
  amount: number;
}

/** Makes the entry of a change in the domain: its identity generated here (DOMAIN-IDENTITY), its time the caller's clock's. */
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
  action: SettlementAuditAction;
  subjectId: string;
  amount: number;
}): AuditEntry {
  return { id: Id.generate().value, groupId, at: at.toISOString(), by, action, subjectId, amount };
}
