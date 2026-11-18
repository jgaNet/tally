import { Id } from '@Architecture/Domain';

/** The change of money Groups writes to the audit (request 28): a balance passed on when a member left. */
export type GroupAuditAction = 'balance-passed';

/**
 * One entry of a group's audit, for a balance passed on when a member left (request 28): who made the change (`by`, the member
 * who left), when (`at`), what (`action`, about `subjectId`, the member who left) and how much (`amount`). Written in the
 * transaction of the leave, never changed.
 */
export interface AuditEntry {
  id: string;
  groupId: string;
  at: string;
  by: string;
  action: GroupAuditAction;
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
  action: GroupAuditAction;
  subjectId: string;
  amount: number;
}): AuditEntry {
  return { id: Id.generate().value, groupId, at: at.toISOString(), by, action, subjectId, amount };
}
