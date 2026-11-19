import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';

/** What the screens read of a settlement, from the SQLite file, outside any transaction. */
export interface ISettlementQueries {
  /** The settlement of this id as it is now, or null. */
  findById(id: string): Promise<SettlementReadModel | null>;
  /** The settlements of a group as they are now, the most recently recorded first (request 19). */
  findByGroup(groupId: string): Promise<SettlementReadModel[]>;
  /** The settlements contested now, the earliest contested first (request 33). */
  findContested(): Promise<SettlementReadModel[]>;
}
