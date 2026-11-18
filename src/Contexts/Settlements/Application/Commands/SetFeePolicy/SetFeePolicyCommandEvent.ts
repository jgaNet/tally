import { CommandEvent } from '@Architecture/Domain';

/**
 * The owner's decision of who bears the group's provider fee (request 38): the group, and `payer`, `payee` or `shared`, as the body
 * says it. The caller is the one who decides, not a field: only the owner may.
 */
export interface SetFeePolicyPayload {
  groupId: string;
  borneBy: string;
}

export class SetFeePolicyCommandEvent extends CommandEvent<SetFeePolicyPayload> {}
