import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';
import { FeePolicyReadModel } from '@Contexts/Settlements/Application/ReadModel/FeePolicyReadModel';

/** What the screens read of a settlement, from the SQLite file, outside any transaction. */
export interface ISettlementQueries {
  /** The settlement of this id as it is now, or null. */
  findById(id: string): Promise<SettlementReadModel | null>;
  /** The settlements of a group as they are now, the most recently recorded first (request 19). */
  findByGroup(groupId: string): Promise<SettlementReadModel[]>;
  /** Who bears the provider's fee of the group, as its owner decided it: the payee until then (request 38). */
  findFeePolicy(groupId: string): Promise<FeePolicyReadModel>;
  /** The settlements contested now, the earliest contested first (request 33). */
  findContested(): Promise<SettlementReadModel[]>;
}
