import {
  AdministratorDecision,
  IAdministratorDecisions,
} from '@Contexts/Groups/Application/Ports/IAdministratorDecisions';
import { IAdministratorDecisionEntries } from '@Contexts/Settlements/Domain/Settlement/Ports/IAdministratorDecisionEntries';

/**
 * Groups' AdministratorDecisions, answered over Settlements' read side (ADR 24): the decisions Settlements keeps, in the
 * transaction of each decision. Groups' composition root gives it Settlements' read; Groups never reaches into Settlements'
 * application.
 */
export class SettlementsAdministratorDecisions implements IAdministratorDecisions {
  constructor(private readonly entries: IAdministratorDecisionEntries) {}

  decisions(): Promise<AdministratorDecision[]> {
    return this.entries.entries();
  }
}
