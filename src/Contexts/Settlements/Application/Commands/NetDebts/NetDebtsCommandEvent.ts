import { CommandEvent } from '@Architecture/Domain';

/** A member asks to net what they and another member owe each other, in one currency, across their groups: the other member's account id and the currency (request 32). */
export class NetDebtsCommandEvent extends CommandEvent<{ with: string; currency: string }> {}
