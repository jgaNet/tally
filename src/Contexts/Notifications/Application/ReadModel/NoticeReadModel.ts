/**
 * A notice as its member reads it: the kind of fact, the group it is about, the member's amount and when it was made. An
 * expense's notice names its expense; a reminder, what the member still owes, names none (request 18).
 */
export interface NoticeReadModel {
  id: string;
  kind: 'expense' | 'reminder';
  groupId: string;
  expenseId?: string;
  amount: number;
  at: string;
}
