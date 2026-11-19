import { CommandEvent } from '@Architecture/Domain';

/** An administrator decides a contested settlement: `paid` is true when the money arrived, false when it did not (request 33). */
export class DecideContestCommandEvent extends CommandEvent<{ settlementId: string; paid: boolean }> {}
