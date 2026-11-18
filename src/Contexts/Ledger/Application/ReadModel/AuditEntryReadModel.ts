/**
 * What a change of money did, as the group's audit shows it (request 28): who made it (`by`), when (`at`), what (`action`), about
 * which thing (`subjectId`) and how much (`amount`). Never changed once it is written.
 */
export interface AuditEntryReadModel {
  id: string;
  at: string;
  by: string;
  action: AuditAction;
  subjectId: string;
  amount: number;
}

export type AuditAction =
  | 'expense-recorded'
  | 'expense-edited'
  | 'expense-deleted'
  | 'settlement-paid'
  | 'settlement-refunded'
  | 'balance-passed';
