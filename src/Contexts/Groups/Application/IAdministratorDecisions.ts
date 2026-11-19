/** An entry of the administrators' log, in Groups' words (request 33, request 34): which administrator decided what about what, and when. */
export interface AdministratorDecision {
  id: string;
  at: string;
  by: string;
  action: 'decided-paid' | 'decided-annulled';
  subjectId: string;
}

/**
 * The decisions the platform's administrators made, as Groups answers the administrators' log with them: a port Groups owns, in its own
 * words, answered by an adapter over Settlements' read model (`AdministratorDecisionsOfSettlements`, in this context's Infrastructure).
 * Settlements' Domain is never imported by Groups' Application.
 */
export interface IAdministratorDecisions {
  /** Every decision, the oldest first. */
  decisions(): Promise<AdministratorDecision[]>;
}
