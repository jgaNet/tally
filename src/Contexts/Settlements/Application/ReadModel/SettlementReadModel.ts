/**
 * One settlement as a member of its group reads it: who paid whom, how much, how it is paid, its status, and when it was
 * recorded. A settlement through the provider also has its `payUrl`, the link where the payer pays (ADR 8). Its `history` is
 * every status it has had, the earliest first, each with when Tally learned it (request 19).
 */
export interface SettlementReadModel {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash' | 'provider' | 'net';
  status: 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'contested' | 'annulled';
  at: string;
  history: { status: SettlementReadModel['status']; at: string }[];
  payUrl?: string;
  /** The provider's fee and who bore it, for a settlement through the provider asked from request 38 on (request 38). */
  fee?: { amount: number; borneBy: 'payer' | 'payee' | 'shared' };
}
