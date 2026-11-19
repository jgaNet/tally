import { CommandEvent } from '@Architecture/Domain';

/**
 * A signed-in member sets who bears the provider's fee of the group: the payer, the payee or both, shared. Only its owner may
 * (request 38); the book refuses the value when it is not one of the three.
 */
export class SetFeePolicyCommandEvent extends CommandEvent<{ groupId: string; borneBy: string }> {}
