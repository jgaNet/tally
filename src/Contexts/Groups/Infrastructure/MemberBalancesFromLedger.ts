import { IMemberBalances } from '@Contexts/Groups/Application/IMemberBalances';
import { IBalanceRoster } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceRoster';

/** Ledger's balances read model, as Ledger gives it to the other contexts: the type the wiring of Groups is given. */
export type BalanceRoster = IBalanceRoster;

/**
 * A member's balance, answered over Ledger's balances read model (ADR 1 T5, feature 9): Groups' port `IMemberBalances` is built
 * on the read model Ledger gives, so a member may leave once their balance is 0, and no domain imports Ledger.
 */
export class MemberBalancesFromLedger implements IMemberBalances {
  constructor(private readonly balances: BalanceRoster) {}

  balanceOf(groupId: string, memberId: string): Promise<number> {
    return this.balances.balanceOf(groupId, memberId);
  }
}
