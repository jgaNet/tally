import { CommandEvent } from '@Architecture/Domain';

/** The payee of a settlement paid through the provider contests it, say the money did not reach them: the settlement's id (request 33). */
export class ContestSettlementCommandEvent extends CommandEvent<{ settlementId: string }> {}
