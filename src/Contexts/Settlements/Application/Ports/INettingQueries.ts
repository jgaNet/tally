import { NettingReadModel } from '@Contexts/Settlements/Application/ReadModel/NettingReadModel';

/** What the screens read of a netting, outside any transaction (request 32). */
export interface INettingQueries {
  findById(id: string): Promise<NettingReadModel | null>;
}
