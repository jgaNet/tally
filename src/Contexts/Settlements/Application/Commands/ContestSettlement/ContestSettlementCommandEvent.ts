import { CommandEvent } from '@Architecture/Domain';

/**
 * The payee of a settlement paid through the provider says the money did not reach them: `settlementId` is the settlement's id, and the
 * caller is its payee. The book decides whether it may be contested; it waits until an administrator decides (request 33).
 */
export class ContestSettlementCommandEvent extends CommandEvent<{
  settlementId: string;
}> {}
