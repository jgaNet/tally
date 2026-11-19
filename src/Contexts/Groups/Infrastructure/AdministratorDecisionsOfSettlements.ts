import { AdministratorDecision, IAdministratorDecisions } from '@Contexts/Groups/Application/IAdministratorDecisions';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/ISettlementQueries';

/**
 * Answers Groups' `IAdministratorDecisions` port over Settlements' read model (CTX-CONTRACTS, ADR 31): the decisions the administrators made,
 * which Settlements writes in the transaction of each decision. It is the one place Groups reads the administrators' log, and only the read
 * model's `administratorDecisions`. The read model is given as a function, read at a request and not when the modules are built (ADR 7).
 */
export class AdministratorDecisionsOfSettlements implements IAdministratorDecisions {
  constructor(private readonly settlements: () => Pick<ISettlementQueries, 'administratorDecisions'>) {}

  async decisions(): Promise<AdministratorDecision[]> {
    return (await this.settlements().administratorDecisions()).map(line => ({
      id: line.id,
      at: line.at,
      by: line.by,
      action: line.action,
      subjectId: line.subjectId,
    }));
  }
}
