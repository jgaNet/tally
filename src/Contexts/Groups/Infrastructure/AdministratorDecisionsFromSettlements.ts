import {
  AdministratorDecision,
  IAdministratorDecisions,
} from '@Contexts/Groups/Application/Ports/IAdministratorDecisions';
import { IGroupAdministratorLog } from '@Contexts/Groups/Application/Ports/IGroupAdministratorLog';
import { IAdministratorDecisionQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/IAdministratorDecisionQueries';

/**
 * Groups' port to the administrators' log, answered over Settlements' read model (request 33) and over Groups' own entries (request 34): the
 * two are one log, the oldest first. Settlements' read model is a function, the one Settlements' wiring exports, because the two wiring files
 * import each other (ADR 4): it is read when the log is asked, not while the files are evaluated.
 */
export class AdministratorDecisionsFromSettlements implements IAdministratorDecisions {
  constructor(
    private groupsLog: IGroupAdministratorLog,
    private settlements: () => IAdministratorDecisionQueries,
  ) {}

  async entries(): Promise<AdministratorDecision[]> {
    const merged = [...(await this.settlements().entries()), ...(await this.groupsLog.entries())];
    // A stable sort by the time each was decided: the entries of one context keep the order they were written in.
    return merged.sort((first, second) => (first.at < second.at ? -1 : first.at > second.at ? 1 : 0));
  }
}
