import { CommandEvent } from '@Architecture/Domain';

/** The payload of a recurring expense stopped: its id, as the route names it. Who may stop it is the domain's to decide. */
export interface StopRecurringExpensePayload {
  recurringId: string;
}

export class StopRecurringExpenseCommandEvent extends CommandEvent<StopRecurringExpensePayload> {}
