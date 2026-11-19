/**
 * One decision of an administrator, as Settlements keeps it in the transaction of the decision (request 33, ADR 24). The
 * administrators' log of Groups reads them, through its own port (AdministratorDecisions).
 */
export interface AdministratorDecisionRow {
  id: string;
  at: string;
  by: string;
  action: 'decided-paid' | 'decided-annulled';
  subjectId: string;
}

/** Settlements' read of the administrators' decisions, every one, the oldest first (request 33). Groups asks it through its own port. */
export interface IAdministratorDecisionEntries {
  entries(): Promise<AdministratorDecisionRow[]>;
}
