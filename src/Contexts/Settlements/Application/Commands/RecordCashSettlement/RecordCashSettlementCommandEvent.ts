import { CommandEvent } from '@Architecture/Domain';

/**
 * The payload of a cash settlement: the group it is recorded in (as the route names it), who paid, and how much. The payee is
 * the caller, not a field: the one who received the money records it.
 */
export interface RecordCashSettlementPayload {
  groupId: string;
  from: string;
  amount: number;
}

export class RecordCashSettlementCommandEvent extends CommandEvent<RecordCashSettlementPayload> {}
