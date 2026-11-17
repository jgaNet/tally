import {
  CommandEvent,
  ConcurrencyConflictException,
  ConflictException,
  Event,
  Exception,
  NotAllowedException,
  NotFoundException,
  UnknownException,
} from '@Architecture/Domain';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { Module } from '@Architecture/Application/Module';
import { awaitOperation } from '@Architecture/Application/AwaitOperation';
import { OperationStatus } from '@Architecture/Application/Operation';

/**
 * Who reaches a command is the transport's to say, at once (API-CALLER-AT-TRANSPORT, ADR 39).
 *
 * A route whose command's outcome is read later calls `acceptCommand()` and nothing else: it
 * publishes the command and answers `202 { operationId }`, or, when nobody is signed in and the
 * command's handler does not say anyone may ask for it (`anyoneMayAsk()`), answers `401` and
 * publishes nothing. The client learns at once that it must sign in, instead of following an
 * operation that was never going to succeed. The linter refuses a route that publishes a command
 * any other way.
 *
 * What a signed-in caller may do is not decided here: the handler still asks for its caller's id,
 * and the aggregate still refuses what that caller may not do, on the operation. A command
 * answered at once (a login) does not come through here and keeps its own refusal.
 *
 *   async archiveNote(req, reply) {
 *     return acceptCommand(req, reply, this.#notesModule, ArchiveNoteCommandEvent.set({ noteId: req.params.id }));
 *   }
 *
 * The request and the reply are typed by what is used of them, so the building blocks name no
 * HTTP framework.
 */
export function acceptCommand(
  req: { executionContext: ExecutionContext },
  reply: { code(statusCode: number): unknown },
  module: Module,
  command: Event<unknown>,
): { operationId: string } | { message: string } {
  const context = req.executionContext;

  if (!signedIn(context) && !anyoneMayAsk(module, command)) {
    reply.code(401);
    return { message: AUTHENTICATION_REQUIRED };
  }

  const operation = context.eventBus.publish(command, context);
  reply.code(202);
  return { operationId: operation.id };
}

/**
 * A command whose answer the client is given in one exchange, when the outcome is decided in time (a
 * sign-up answers the new thing's id at once). The command is published as `acceptCommand()` publishes
 * it, and the answer waits for its outcome for at most `timeoutMs`:
 *
 * - `201 { id }` when the handler succeeded: the id it returned;
 * - the refusal's status with `{ type, message }` when it refused: the rule's exception, named by its
 *   kind (`409` for a conflict, `404` for a thing not there, `403`/`401` for a caller refused, else `400`);
 * - `202 { operationId }` when the deadline passed first: the outcome is then read at the operation, as
 *   `acceptCommand()` answers it. Nothing is cancelled; the handler finishes and the Tracker records it.
 *
 * A command nobody may ask for by anonymous means is refused with `401` before anything is published,
 * as `acceptCommand()` refuses it (API-CALLER-AT-TRANSPORT).
 *
 *   async signUp(req, reply) {
 *     return acceptCommandAtOnce(req, reply, this.#groupsModule, SignUpCommandEvent.set(req.body));
 *   }
 */
export async function acceptCommandAtOnce(
  req: { executionContext: ExecutionContext },
  reply: { code(statusCode: number): unknown },
  module: Module,
  command: Event<unknown>,
  { timeoutMs }: { timeoutMs?: number } = {},
): Promise<unknown> {
  const context = req.executionContext;

  if (!signedIn(context) && !anyoneMayAsk(module, command)) {
    reply.code(401);
    return { message: AUTHENTICATION_REQUIRED };
  }

  const operation = await awaitOperation(context.eventBus.publish(command, context), { timeoutMs });

  if (operation.status === OperationStatus.SUCCESS && operation.result?.isSuccess()) {
    reply.code(201);
    return { id: operation.result.data };
  }
  if (operation.status === OperationStatus.ERROR && operation.result?.isFailure()) {
    const error: unknown = operation.result.error;
    reply.code(refusalStatusOf(error, context));
    return Exception.isException(error)
      ? { type: error.type, message: error.message }
      : { type: 'UnknownException', message: INTERNAL_ERROR };
  }
  reply.code(202);
  return { operationId: operation.id };
}

/** The body of a `500`: a programming error is logged where it happens, never told to the client. */
const INTERNAL_ERROR = 'Internal error';

/** The status of a refusal a command answers at once, by the kind of the rule's exception. */
function refusalStatusOf(error: unknown, context: ExecutionContext): number {
  if (error instanceof NotAllowedException) return notAllowedStatus(context);
  if (error instanceof NotFoundException) return 404;
  if (error instanceof ConcurrencyConflictException || error instanceof ConflictException) return 409;
  if (error instanceof UnknownException || !Exception.isException(error)) return 500;
  return 400;
}

/**
 * The status of a refusal a query answers at once (`NotAllowedException`): `401` to a caller who is
 * not signed in, as HTTP says for missing credentials, `403` to a signed-in caller the rule refuses.
 * One refusal has one status, for a command and a query alike.
 */
export const notAllowedStatus = (context: ExecutionContext): 401 | 403 => (signedIn(context) ? 403 : 401);

/** The body of a `401`, the same on every route. */
export const AUTHENTICATION_REQUIRED = 'Authentication required';

const signedIn = (context: ExecutionContext): boolean => Boolean(context.auth.subjectId);

/** What the handler the Module lists for this command says; a command no handler answers is a wiring error. */
function anyoneMayAsk(module: Module, command: Event<unknown>): boolean {
  const handlers = module.commands.find(({ event }) => command instanceof event)?.handlers ?? [];
  if (!handlers.length) {
    throw new Error(`No handler for ${command.name} in module ${module.name}: list it in the context's wiring`);
  }
  return handlers.every(handler => handler.anyoneMayAsk(command as CommandEvent<unknown>));
}
