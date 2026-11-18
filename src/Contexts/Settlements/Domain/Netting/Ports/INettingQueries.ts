/** A netting as the two people read it: who asked, with whom, its currency, the amount netted, and its settlements in the order made. */
export interface NettingView {
  id: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
  settlements: string[];
}

/** The read side of nettings (QUERY-READ-MODELS): a netting is read only by the two people in it, which the handler asks. */
export interface INettingQueries {
  /** The netting with this id, or null if there is none. */
  findById(id: string): Promise<NettingView | null>;
}
