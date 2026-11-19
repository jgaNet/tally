import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';

/** The nettings of Settlements, stored with the settlements they made (request 32). A netting is written once and never changed. */
export interface INettingRepository {
  /** Stores a netting made now: the netting and its settlements, in the order they were made. */
  save(netting: Netting): Promise<void>;
}
