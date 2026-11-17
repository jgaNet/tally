import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';

/** What the screens read of a settlement, from the SQLite file, outside any transaction. */
export interface ISettlementQueries {
  /** The settlement of this id as it is now, or null. */
  findById(id: string): Promise<SettlementReadModel | null>;
}
