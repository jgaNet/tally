/**
 * What a change of money is, in the audit's words (request 28, docs/adr/0027): an expense recorded, edited or deleted, a settlement paid
 * or refunded, and the balance a member who left passed to the owner. Nothing else is an entry.
 */
export type AuditAction =
  | 'expense-recorded'
  | 'expense-edited'
  | 'expense-deleted'
  | 'settlement-paid'
  | 'settlement-refunded'
  | 'balance-passed';

/**
 * One entry of a group's audit: who made the change (`by`, an account id), when (`at`), what it was (`action`, about `subjectId`) and how
 * much (`amount`). Written with the change and never changed (docs/adr/0027).
 */
export interface AuditEntryView {
  id: string;
  at: string;
  by: string;
  action: AuditAction;
  subjectId: string;
  amount: number;
}
