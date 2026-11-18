import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';

/**
 * The nettings, as aggregates: a netting is created once and never changed, so the repository only inserts it, in the transaction
 * of the netting, beside the books its settlements were recorded in.
 */
export interface INettingRepository {
  save(netting: Netting): Promise<void>;
}
