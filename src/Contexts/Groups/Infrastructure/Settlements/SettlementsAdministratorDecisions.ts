import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import {
  AdministratorDecision,
  IAdministratorDecisions,
} from '@Contexts/Groups/Domain/Account/Ports/IAdministratorDecisions';

/**
 * Groups' port onto Settlements, answered over Settlements' read model (request 33): the administrators' log, as Settlements wrote
 * each decision in the transaction of the decision, in Groups' own words.
 */
export class SettlementsAdministratorDecisions implements IAdministratorDecisions {
  constructor(private settlements: ISettlementQueries) {}

  async all(): Promise<AdministratorDecision[]> {
    return (await this.settlements.adminLog()).map(({ id, at, by, action, subjectId }) => ({
      id,
      at,
      by,
      action,
      subjectId,
    }));
  }
}
