import { AdministratorDecisionEntry } from '@Contexts/Settlements/Domain/Settlement/Ports/IAdministratorDecisionQueries';

/**
 * Settlements' own administrators' log (request 33): written in the transaction of each decision, so the entry is there when the decision
 * is answered, and never changed afterwards.
 */
export interface IAdministratorDecisionLog {
  record(entry: AdministratorDecisionEntry): Promise<void>;
}
