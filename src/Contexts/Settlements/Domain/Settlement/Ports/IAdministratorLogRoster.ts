import { AdministratorDecision } from '@Contexts/Settlements/Domain/Settlement/AdministratorLog';

/**
 * The administrators' log, as Settlements' read model gives it to the other contexts (request 33, ADR 28): a port Settlements owns the read of,
 * answered over its own table. `decisions` answers every decision the administrators made, the oldest first.
 */
export interface IAdministratorLogRoster {
  decisions(): Promise<AdministratorDecision[]>;
}
