/**
 * One decision an administrator made about a contested settlement, as Groups reads it for the administrators' log (request 33): its id,
 * when it was made, which administrator made it, what it was, and the settlement it is about.
 */
export interface AdministratorDecisionView {
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly action: 'decided-paid' | 'decided-annulled';
  readonly subjectId: string;
}

/**
 * The administrators' log, as Groups reads it (request 33, ADR 28): a port Groups owns, answered over Settlements' read model, which holds
 * the decisions in the transaction that made each one. `decisions` answers every decision, the oldest first.
 */
export interface IAdministratorDecisions {
  decisions(): Promise<AdministratorDecisionView[]>;
}
