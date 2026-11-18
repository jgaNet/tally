import { CommandEvent } from '@Architecture/Domain';

/** An administrator's decision of a contested settlement (request 33): `paid` is whether the money arrived. */
export interface DecideContestPayload {
  settlementId: string;
  paid: boolean;
}

export class DecideContestCommandEvent extends CommandEvent<DecideContestPayload> {}
