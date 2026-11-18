import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import {
  AdministratorDecision,
  IAdministratorDecisions,
} from '@Contexts/Groups/Domain/Account/Ports/IAdministratorDecisions';
import { IAdministratorsLogQueries } from '@Contexts/Groups/Domain/Account/Ports/IAdministratorsLog';

/**
 * Groups' port onto Settlements, answered over Settlements' read model (request 33): the administrators' log, as Settlements wrote
 * each decision in the transaction of the decision, in Groups' own words. Groups' own entries (request 34: a suspension or a
 * reinstatement) are read beside them, and the log is answered oldest first.
 */
export class SettlementsAdministratorDecisions implements IAdministratorDecisions {
  constructor(
    private settlements: ISettlementQueries,
    private ownEntries: IAdministratorsLogQueries,
  ) {}

  async all(): Promise<AdministratorDecision[]> {
    const own = await this.ownEntries.all();
    const decided = (await this.settlements.adminLog()).map(({ id, at, by, action, subjectId }) => ({
      id,
      at,
      by,
      action,
      subjectId,
    }));
    // A stable sort by the time of each entry: entries of the same time keep the order they were read in.
    return [...own, ...decided].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
}
