import { MemberBalance } from '@Contexts/Settlements/Domain/Suggestion/DTOs';

/**
 * The balances of a group, as Settlements needs them to suggest the transfers that would bring them to 0 (conventions/domain.yaml,
 * the Ledger → Settlements link; docs/adr/0012). Settlements owns the port, in its own words; Ledger answers it through an adapter
 * in Settlements' Infrastructure, over Ledger's read model. A member with nothing recorded is not listed: its balance is 0.
 */
export interface IGroupBalances {
  balancesOf(groupId: string): Promise<MemberBalance[]>;
}
