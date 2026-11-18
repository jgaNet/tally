/**
 * What an administrator decided about a contested settlement (request 33, ADR 28): the money arrived (`decided-paid`, the settlement is paid
 * again) or it did not (`decided-annulled`, the settlement is annulled). Written in the transaction of the decision, and never changed.
 */
export type AdministratorAction = 'decided-paid' | 'decided-annulled';

/** One entry of the administrators' log: when the decision was made, by which administrator, what it was, and the settlement it is about. */
export interface AdministratorDecision {
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly action: AdministratorAction;
  readonly subjectId: string;
}

/**
 * The identity of a decision, born with it: a settlement is decided once (it is contested once, and only a contested one is decided), so its
 * entry's id is the settlement's own with the decision, and a second write meets the primary key.
 */
export const administratorDecisionId = {
  of: (settlementId: string) => `decision:${settlementId}`,
};
