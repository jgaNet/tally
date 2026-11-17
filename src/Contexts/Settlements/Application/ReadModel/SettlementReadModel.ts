import { SettlementMethod, SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/**
 * One settlement as a member of its group reads it: who paid whom, how much, how it is paid, where it stands and when it was
 * recorded. A settlement through the provider has the link its payer pays at (`payUrl`); one in cash has none.
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
}
