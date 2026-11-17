/** A settlement as a book recorded it: the id the domain generated, the group, the payer, the payee, the amount and when. */
export interface ISettlementSnapshot {
  _id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  at: string;
}

/** The settlement book as the store keeps it: its identity, its group and the version it was read at. */
export interface ISettlementBookSnapshot {
  _id: string;
  groupId: string;
  version: number;
  /** The settlements recorded since the book was read: the store writes them with the version it moves on. */
  settlements: ISettlementSnapshot[];
}
