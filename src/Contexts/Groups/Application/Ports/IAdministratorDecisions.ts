/**
 * One decision an administrator made about a settlement, as Settlements keeps it (request 33, ADR 24): when, by which
 * administrator, what (`decided-paid` or `decided-annulled`) and about which settlement.
 */
export interface AdministratorDecision {
  id: string;
  at: string;
  by: string;
  action: 'decided-paid' | 'decided-annulled';
  subjectId: string;
}

/**
 * The administrators' log, asked by Groups in its own words (AdministratorDecisions, ADR 24): every decision an administrator
 * made, the oldest first. Groups owns the port; its adapter answers it over Settlements' read side, which keeps the entries.
 */
export interface IAdministratorDecisions {
  decisions(): Promise<AdministratorDecision[]>;
}
