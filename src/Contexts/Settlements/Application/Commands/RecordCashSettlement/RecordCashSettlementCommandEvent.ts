import { CommandEvent } from '@Architecture/Domain';

/**
 * The payload of a cash settlement: the group it is recorded in (as the route names it), who paid, and how much, in the group's
 * currency (`amount`), or in another one (`original`, request 39): exactly one of them is given. The payee is the caller, not a
 * field: the one who received the money records it.
 */
export interface RecordCashSettlementPayload {
  groupId: string;
  from: string;
  amount: number | null;
  original: { currency: string; amount: number } | null;
}

export class RecordCashSettlementCommandEvent extends CommandEvent<RecordCashSettlementPayload> {}
