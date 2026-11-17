/** A notice as a person reads it: which group and which expense it is about, their share of it, and when it was made. */
export interface NoticeReadModel {
  id: string;
  kind: 'expense';
  groupId: string;
  expenseId: string;
  amount: number;
  at: string;
}
