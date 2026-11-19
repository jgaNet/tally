import { Event, publicName } from '@Architecture/Domain';
import { IOperation } from '@Architecture/Application';

import { OperationRecord } from '@Contexts/Tracker/Application/ReadModel/OperationRecord';

/**
 * The operations whose caller proves nothing once they have run: deleting an account (request 35, ADR 26) ends the token that
 * asked for it. Its record names no subject, so it is followed by whoever holds its id, as a sign-up's is (ADR 27): the id is
 * unguessable and only ever given to the caller, in the 202.
 */
const ENDS_ITS_CALLER: ReadonlySet<string> = new Set(['DeleteAccount']);

/**
 * The projection itself: from what the bus knows about an operation to what a client may
 * see. It keeps the trace and the caller, drops the execution context (logger, bus, unit of
 * work have no place in a read model) and the payload (it may carry a secret), and flattens
 * the Result into `result` / `error`.
 */
export function toOperationRecord(operation: IOperation<Event<unknown>>): OperationRecord {
  const { result } = operation;
  const name = publicName(operation.event);

  return {
    id: operation.id,
    name,
    status: operation.status,
    traceId: operation.context.traceId,
    subjectId: (!ENDS_ITS_CALLER.has(name) && operation.context.auth.subjectId) || undefined,
    result: result?.isSuccess() ? result.data : undefined,
    error: result?.isFailure() ? { type: result.error.type, message: result.error.message } : undefined,
    createdAt: operation.createdAt,
    finishedAt: operation.finishedAt,
  };
}
