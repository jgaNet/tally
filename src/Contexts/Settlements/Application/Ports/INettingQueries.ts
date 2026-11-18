import { NettingReadModel } from '@Contexts/Settlements/Application/ReadModel/NettingReadModel';

/** Settlements' read side of nettings: a netting as it was recorded, or null when there is none under the id. */
export interface INettingQueries {
  findById(id: string): Promise<NettingReadModel | null>;
}
