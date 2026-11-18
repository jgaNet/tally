import { CommandEvent } from '@Architecture/Domain';

/**
 * The owner of a group says who bears the provider's fee of its payments: `borneBy` is `payer`, `payee` or `shared`. The caller must be
 * the group's owner; the book decides (request 38).
 */
export class SetFeePolicyCommandEvent extends CommandEvent<{
  groupId: string;
  borneBy: string;
}> {}
