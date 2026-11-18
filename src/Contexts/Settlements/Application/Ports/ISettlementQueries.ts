import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';
import { FeeBorne } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/** Settlements' read side: a settlement as it was recorded, or null when there is none under the id. */
export interface ISettlementQueries {
  findById(id: string): Promise<SettlementReadModel | null>;
  /**
   * Every settlement of the group, in the order they were recorded, the earliest first. Whoever asks: the handler decides whether the
   * caller may read them, and orders them as its query says.
   */
  ofGroup(groupId: string): Promise<SettlementReadModel[]>;
  /** Every settlement contested now, the earliest contested first, each with its history (request 33). */
  contested(): Promise<SettlementReadModel[]>;
  /** Who bears the provider's fee of the group's payments, as its owner last said; the payee when none has said (request 38). */
  feePolicyOf(groupId: string): Promise<FeeBorne>;
}
