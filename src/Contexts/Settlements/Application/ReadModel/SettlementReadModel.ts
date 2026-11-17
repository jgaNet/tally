/** One settlement as a member of its group reads it: who paid whom, how much, how it was paid, its status and when it was recorded. */
export interface SettlementReadModel {
  id: string;
  groupId: string;
  /** The payer's account id. */
  from: string;
  /** The payee's account id: the member who recorded it. */
  to: string;
  amount: number;
  method: 'cash';
  status: 'paid';
  /** When it was recorded, as an ISO string. */
  at: string;
}
