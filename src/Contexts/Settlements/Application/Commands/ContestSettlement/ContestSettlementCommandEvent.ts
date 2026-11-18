import { CommandEvent } from '@Architecture/Domain';

/** A settlement contested (request 33): the settlement, named as the route names it. The member who contests is the caller, its payee. */
export interface ContestSettlementPayload {
  settlementId: string;
}

export class ContestSettlementCommandEvent extends CommandEvent<ContestSettlementPayload> {}
