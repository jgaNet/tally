import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import {
  AdministratorDecision,
  IAdministratorDecisions,
} from '@Contexts/Groups/Domain/Account/Ports/IAdministratorDecisions';

/**
 * Groups' AdministratorDecisions, answered over Settlements' read model (request 33, docs/adr/0033): the decisions of the administrators on
 * contested settlements, translated here into Groups' words.
 */
export class AdministratorDecisionsOfSettlements implements IAdministratorDecisions {
  constructor(private readonly settlements: ISettlementQueries) {}

  async decisionsOf(): Promise<AdministratorDecision[]> {
    const decisions = await this.settlements.administratorDecisions();
    return decisions.map(({ id, at, by, action, subjectId }) => ({ id, at, by, action, subjectId }));
  }
}
