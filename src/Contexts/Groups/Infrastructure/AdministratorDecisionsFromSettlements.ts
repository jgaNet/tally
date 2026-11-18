import {
  AdministratorDecisionView,
  IAdministratorDecisions,
} from '@Contexts/Groups/Application/IAdministratorDecisions';
import { IAdministratorLogRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/IAdministratorLogRoster';

/** Settlements' read model of the administrators' log, as Settlements gives it to the other contexts: the type Groups is given. */
export type AdministratorLogRoster = IAdministratorLogRoster;

/**
 * The administrators' decisions, answered over Settlements' read model (request 33, ADR 28): Groups' port `IAdministratorDecisions` is built
 * on the roster Settlements gives, so the log is read by Groups and written by Settlements, and no domain imports Settlements.
 */
export class AdministratorDecisionsFromSettlements implements IAdministratorDecisions {
  constructor(private readonly roster: AdministratorLogRoster) {}

  decisions(): Promise<AdministratorDecisionView[]> {
    return this.roster.decisions();
  }
}
