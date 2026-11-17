import { CommandEvent } from '@Architecture/Domain';

/** A member asks to pay another member of the group through the provider: the group, the payee's account id, and the amount. */
export class PayThroughProviderCommandEvent extends CommandEvent<{ groupId: string; to: string; amount: number }> {}
