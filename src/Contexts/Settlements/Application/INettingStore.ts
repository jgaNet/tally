import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';

/** What a screen shows of one netting: a read model, never the aggregate (QUERY-READ-MODELS, request 32). */
export interface NettingView {
  readonly id: string;
  readonly by: string;
  readonly with: string;
  readonly currency: string;
  readonly amount: number;
  /** The settlements the netting made, in the order they were made. */
  readonly settlements: readonly string[];
}

/**
 * The store of nettings, the port the netting use cases write and read through (feature 32). `save` keeps a netting made, once, with its
 * settlements' ids in order, in the transaction of the command that decided it, with the settlements it names (the books are saved there
 * too, so a netting is kept whole or not at all). `viewOf` reads a netting as it was saved, or `undefined` when there is none.
 */
export interface INettingStore {
  save(netting: Netting): Promise<void>;
  viewOf(nettingId: string): Promise<NettingView | undefined>;
}
