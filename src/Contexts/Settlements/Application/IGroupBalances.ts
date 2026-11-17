import { MemberBalance } from '@Contexts/Settlements/Domain/Settlement/SuggestedSettlements';

/**
 * The balances of a group's members, as Settlements asks them (conventions/domain.yaml, ADR 9, the storm's `GroupBalances`): a port
 * Settlements owns, in its own words, answered over Ledger's balances read model. `balancesOf` answers the members the group's
 * expenses have counted, in no particular order, each with what it owes (negative) or is owed (positive), in the group's
 * currency's hundredths; a member nothing has counted is absent, and the reader gives it 0. It is read in one snapshot, so the
 * balances of one answer add up to 0. The adapter is Settlements' infrastructure over Ledger's read model, so no domain imports
 * Ledger.
 */
export interface IGroupBalances {
  balancesOf(groupId: string): Promise<MemberBalance[]>;
}
