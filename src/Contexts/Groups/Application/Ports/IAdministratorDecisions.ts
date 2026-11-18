/** A decision an administrator made, as the administrators' log shows it (requests 33, 34): when, by which administrator, what, and about what. */
export interface AdministratorDecision {
  id: string;
  at: string;
  by: string;
  action: 'decided-paid' | 'decided-annulled' | 'suspended' | 'reinstated';
  subjectId: string;
}

/**
 * Groups' port to the administrators' log (the storm's AdministratorDecisions, requests 33 and 34): every decision an administrator made, in
 * Settlements and in Groups, the oldest first. Answered by an adapter over both read models, and read by the query answering the log, outside
 * any transaction.
 */
export interface IAdministratorDecisions {
  entries(): Promise<AdministratorDecision[]>;
}
