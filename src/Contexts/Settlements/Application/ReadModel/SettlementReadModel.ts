import { FeeBorne, SettlementMethod, SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/** A status a settlement had, and when Tally learned it, as an ISO string (request 19). */
export interface SettlementHistoryLine {
  status: SettlementStatus;
  at: string;
}

/**
 * One settlement as a member of its group reads it: who paid whom, how much, how it is paid, where it stands and when it was
 * recorded. A settlement through the provider has the link its payer pays at (`payUrl`); one in cash has none. `history` is every
 * status it has had, the earliest first, each with when Tally learned it.
 */
export interface SettlementReadModel {
  id: string;
  groupId: string;
  /** The payer's account id. */
  from: string;
  /** The payee's account id: the member who recorded it, or who asked for it. */
  to: string;
  amount: number;
  method: SettlementMethod;
  status: SettlementStatus;
  /** When it was recorded, as an ISO string. */
  at: string;
  payUrl?: string;
  /** The provider's fee and who bore it, for a settlement through the provider asked for from request 38 on (no other has one). */
  fee?: { amount: number; borneBy: FeeBorne };
  history: SettlementHistoryLine[];
}
