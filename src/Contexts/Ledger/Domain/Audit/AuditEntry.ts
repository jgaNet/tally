/**
 * What an audit entry records (feature 28, request 28): a change of money in a group. Each context writes the entries of its own changes in
 * the transaction of the change; Ledger reads them all (ADR 23).
 */
export type AuditAction =
  | 'expense-recorded'
  | 'expense-edited'
  | 'expense-deleted'
  | 'settlement-paid'
  | 'settlement-refunded'
  | 'settlement-contested'
  | 'balance-passed';

/**
 * An entry of a group's audit: who made the change (`by`, an account id), when (`at`), what (`action`, about `subjectId`), and how much
 * (`amount`, in the group's currency's hundredths). Never changed, and never removed.
 */
export interface AuditEntry {
  readonly id: string;
  readonly groupId: string;
  readonly at: string;
  readonly by: string;
  readonly action: AuditAction;
  readonly subjectId: string;
  readonly amount: number;
}

/**
 * The identity of the entry of a change, born with the change it records (DOMAIN-IDENTITY): a change is recorded once, so its entry's
 * id is the change's own. An expense is recorded, and deleted, once; an edit is identified by the version it was made from, which an
 * edit of that version can make once only (CONC-OPTIMISTIC). A second write of an entry therefore meets its primary key, and the
 * transaction of the change fails with it: a change has one entry, however many servers run.
 */
export const expenseAuditId = {
  recorded: (expenseId: string) => `expense-recorded:${expenseId}`,
  edited: (expenseId: string, fromVersion: number) => `expense-edited:${expenseId}:${fromVersion}`,
  deleted: (expenseId: string) => `expense-deleted:${expenseId}`,
};
