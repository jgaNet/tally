import { MemberBalanceReadModel } from '@Contexts/Ledger/Application/ReadModel/MemberBalanceReadModel';

export interface IBalanceQueries {
  /** The balances kept for the group's members, whoever asks: a member with nothing recorded has no row. */
  balancesOf(groupId: string): Promise<MemberBalanceReadModel[]>;
}
