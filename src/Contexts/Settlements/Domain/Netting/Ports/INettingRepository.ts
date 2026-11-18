import { IResult } from '@Architecture/Domain';

import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';

/**
 * Stores a netting in the command's transaction, with the settlements it made, so that they are stored together or not at all. A
 * netting is written once: it is never changed afterwards.
 */
export interface INettingRepository {
  save(netting: Netting): Promise<IResult>;
}
