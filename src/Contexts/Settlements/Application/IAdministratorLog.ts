import { AdministratorDecision } from '@Contexts/Settlements/Domain/Settlement/AdministratorLog';

/**
 * The administrators' log, the port the decision writes through (request 33, ADR 28): a decision is recorded in the transaction that decided
 * it, so an entry is there as soon as the decision is answered, and a decision refused leaves none. Read through Settlements' read model
 * (`IAdministratorLogRoster`).
 */
export interface IAdministratorLog {
  record(decision: AdministratorDecision): Promise<void>;
}
