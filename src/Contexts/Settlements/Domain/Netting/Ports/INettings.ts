import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';

/** The store of nettings: a netting is stored once, in the transaction that stores its settlements (docs/adr/0032). */
export interface INettings {
  /** Stores the netting and its settlements' ids, in the order they were made. Inside a transaction only. */
  save(netting: Netting): Promise<void>;
}
