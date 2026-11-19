/** The changes of money an audit entry records (request 28). */
export type AuditAction =
  | 'expense-recorded'
  | 'expense-edited'
  | 'expense-deleted'
  | 'settlement-contested'
  | 'settlement-paid'
  | 'settlement-refunded'
  | 'balance-passed';

/** One entry of a group's audit, as it reads: who made the change (`by`), when, what (`action`, about `subjectId`), and how much. */
export interface AuditEntryReadModel {
  id: string;
  at: string;
  by: string;
  action: AuditAction;
  subjectId: string;
  amount: number;
}
