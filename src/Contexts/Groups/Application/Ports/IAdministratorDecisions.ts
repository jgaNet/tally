/** A decision an administrator made, as the administrators' log shows it (request 33): when, by which administrator, what, and about what. */
export interface AdministratorDecision {
  id: string;
  at: string;
  by: string;
  action: 'decided-paid' | 'decided-annulled';
  subjectId: string;
}

/**
 * Groups' port to Settlements, which Groups owns (the storm's AdministratorDecisions, request 33): every decision an administrator made, the
 * oldest first. Answered by an adapter over Settlements' read model, and read by the query answering the log, outside any transaction.
 */
export interface IAdministratorDecisions {
  entries(): Promise<AdministratorDecision[]>;
}
