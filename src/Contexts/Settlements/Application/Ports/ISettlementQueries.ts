import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';

/** Settlements' read side: a settlement as it was recorded, or null when there is none under the id. */
export interface ISettlementQueries {
  findById(id: string): Promise<SettlementReadModel | null>;
}
