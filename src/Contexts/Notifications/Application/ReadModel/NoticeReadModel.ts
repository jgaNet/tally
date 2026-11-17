/** A notice as its member reads it: the kind of fact, the group and expense it is about, the member's share, and when it was made. */
export interface NoticeReadModel {
  id: string;
  kind: 'expense';
  groupId: string;
  expenseId: string;
  amount: number;
  at: string;
}
