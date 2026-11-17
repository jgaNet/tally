import { ISettlementRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementRoster';
import { ISettledAmounts, SettledChange } from '@Contexts/Ledger/Application/ISettledAmounts';

/** Settlements' read model of what its settlements move, as Settlements gives it to the other contexts: the type the wiring is given. */
export type SettlementsRoster = ISettlementRoster;

/**
 * What the settlements of a group move in each member's balance, answered over Settlements' read model (ADR 10): Ledger's port
 * `ISettledAmounts` is built on the roster Settlements gives, so a balance counts a settlement as soon as it is recorded, and no
 * domain imports Settlements.
 */
export class SettledAmountsFromSettlements implements ISettledAmounts {
  constructor(private readonly roster: SettlementsRoster) {}

  async settledOf(groupId: string): Promise<SettledChange[]> {
    return this.roster.settledOf(groupId);
  }
}
