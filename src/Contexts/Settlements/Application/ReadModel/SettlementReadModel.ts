/** One settlement as a member of its group reads it: who paid whom, how much, how it was paid, its status, and when it was recorded. */
export interface SettlementReadModel {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash';
  status: 'paid';
  at: string;
}
