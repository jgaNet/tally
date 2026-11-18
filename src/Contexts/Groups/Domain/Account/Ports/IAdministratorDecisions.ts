/**
 * One decision an administrator made on a contested settlement, as the administrators' log keeps it (request 33, docs/adr/0033): when
 * (`at`), by which administrator (`by`, an account id), what (`action`) and about which settlement (`subjectId`).
 */
export interface AdministratorDecision {
  id: string;
  at: string;
  by: string;
  action: 'decided-paid' | 'decided-annulled';
  subjectId: string;
}

/**
 * The administrators' log, as Groups reads it (conventions/domain.yaml, the Settlements → Groups link; docs/adr/0033): the decisions Settlements
 * keeps, the oldest first, answered by an adapter in Groups' Infrastructure over Settlements' read model. Only an administrator reads it.
 */
export interface IAdministratorDecisions {
  decisionsOf(): Promise<AdministratorDecision[]>;
}
