/** An entry of the administrators' log, in Groups' own words: which administrator decided what, about which thing, and when (request 33). */
export interface AdministratorDecision {
  id: string;
  at: string;
  by: string;
  action: string;
  subjectId: string;
}

/**
 * Groups' own port onto Settlements: the decisions the administrators made, which Settlements wrote in the transaction of each
 * decision (request 33). Groups answers the administrators' log with them; the adapter answers over Settlements' read model.
 * No domain imports Settlements.
 */
export interface IAdministratorDecisions {
  /** Every decision of an administrator, the oldest first. */
  all(): Promise<AdministratorDecision[]>;
}
