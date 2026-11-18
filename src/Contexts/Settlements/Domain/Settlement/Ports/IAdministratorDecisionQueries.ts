/** A decision an administrator made about a contested settlement, as the administrators' log keeps it (request 33). */
export interface AdministratorDecisionEntry {
  id: string;
  at: string;
  by: string;
  action: 'decided-paid' | 'decided-annulled';
  subjectId: string;
}

/**
 * The read-model port Groups reads the administrators' log through (request 33): every decision an administrator made, the oldest first.
 * Read outside any transaction, so it takes no lock of its own.
 */
export interface IAdministratorDecisionQueries {
  entries(): Promise<AdministratorDecisionEntry[]>;
}
