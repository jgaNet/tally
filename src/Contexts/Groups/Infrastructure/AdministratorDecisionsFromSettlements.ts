import {
  AdministratorDecision,
  IAdministratorDecisions,
} from '@Contexts/Groups/Application/Ports/IAdministratorDecisions';
import { IAdministratorDecisionQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/IAdministratorDecisionQueries';

/**
 * Groups' port to Settlements, answered over Settlements' read model (request 33). The read model is a function, the one Settlements'
 * wiring exports, because the two wiring files import each other (ADR 4): it is read when the log is asked, not while the files are evaluated.
 */
export class AdministratorDecisionsFromSettlements implements IAdministratorDecisions {
  constructor(private settlements: () => IAdministratorDecisionQueries) {}

  async entries(): Promise<AdministratorDecision[]> {
    return this.settlements().entries();
  }
}
