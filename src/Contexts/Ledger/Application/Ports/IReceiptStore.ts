import { IResult } from '@Architecture/Domain';

/**
 * The receipts store, as Ledger needs it (request 26, docs/adr/0025): where a receipt's file is kept, answered with the link it is read at.
 * Ledger owns the port, in its own words; an adapter in its Infrastructure calls the store's API. The link is a plain value the Receipt takes
 * and checks (DOMAIN-NON-DETERMINISM): the store decides where the file is kept, not whether it may be.
 */
export interface IReceiptStore {
  /**
   * Keeps the file, of the type it was read as, and answers the link it is read at. A refusal when the store kept no file: it answered
   * anything else, or did not answer within 5 seconds. It never throws.
   */
  keep(file: { bytes: Uint8Array; type: string }): Promise<IResult<string>>;
}
