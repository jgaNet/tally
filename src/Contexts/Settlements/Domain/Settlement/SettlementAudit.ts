/**
 * The audit entries a settlement writes (feature 28, request 28, ADR 23): a settlement the balances start to count (`settlement-paid`, in
 * cash when it is recorded, through the provider when the provider says it succeeded), and one they stop counting (`settlement-refunded`,
 * when the provider says it is refunded). Written in the transaction of the change, and never changed.
 */
export type SettlementAuditAction = 'settlement-paid' | 'settlement-refunded' | 'settlement-contested';

export interface SettlementAuditEntry {
  readonly id: string;
  readonly groupId: string;
  readonly at: string;
  /** The member the change acts for: a cash payment's payee, a provider's payment's payer, a refund's payee, a contest's payee, a decision's administrator. */
  readonly by: string;
  readonly action: SettlementAuditAction;
  readonly subjectId: string;
  readonly amount: number;
}

/**
 * The identity of a settlement's entry, born with the change it records: a settlement is paid once and refunded once, so its entry's id is
 * the settlement's own with the change (a second write meets the primary key, see Ledger's ADR 23).
 */
export const settlementAuditId = {
  paid: (settlementId: string) => `settlement-paid:${settlementId}`,
  refunded: (settlementId: string) => `settlement-refunded:${settlementId}`,
  contested: (settlementId: string) => `settlement-contested:${settlementId}`,
  /** The money an administrator decided arrived: a second `settlement-paid` of the same settlement, with its own identity (request 33). */
  decidedPaid: (settlementId: string) => `settlement-decided-paid:${settlementId}`,
};
