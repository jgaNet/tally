import { CommandEvent } from '@Architecture/Domain';

/**
 * An administrator decides a contested settlement: `paid` is `true` when the money arrived. Only an administrator may ask for it, and only
 * a contested settlement is decided, once (request 33).
 */
export class DecideContestCommandEvent extends CommandEvent<{
  settlementId: string;
  paid: boolean;
}> {}
