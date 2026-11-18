import { v4 as uuidv4 } from 'uuid';

import { Event, Result } from '@Architecture/Domain';
import {
  Clock,
  CommandHandler,
  EventBus,
  EventHandler,
  Inbox,
  ExecutionContext,
  IEventEmitter,
  IOperation,
  OperationStatus,
} from '@Architecture/Application';

/**
 * A process-local bus on top of Node's EventEmitter. Publishing returns an Operation whose
 * status and result the handler fills in; the Tracker context records those (see
 * Contexts/Tracker/Infrastructure/TrackedEventBus.ts, which decorates this bus).
 *
 * Delivery is idempotent per subscriber (ADR 24): a message relayed from the outbox carries its
 * entry's id, and a subscriber that already handled that id — and did not fail — is not handed
 * it again. The inbox is the bus's, not each handler's, so a reaction stays a plain `execute()`;
 * a reaction that failed is handed the message again, which is what at-least-once is for. An
 * operation's `delivered` settles once every reaction it started has finished, and says whether
 * all of them succeeded: the outbox's relay acknowledges an entry on it, and on nothing sooner.
 */
export class InMemoryEventBus implements EventBus {
  #eventEmitter: IEventEmitter;
  /** The messages each subscriber handled: the inbox, in the process unless the wiring gives a durable one. */
  #inbox: Inbox;
  /** While a message is emitted, the reactions it starts: what its `delivered` waits for. */
  #reactions = new Map<IOperation<Event<unknown>>, Promise<boolean>[]>();
  /** How many subscribers each channel has: a subscriber's name is its channel and its place in the wiring. */
  #subscribers = new Map<string, number>();
  /** When an operation was created and finished: the application's clock (DOMAIN-ONE-CLOCK). */
  #clock: Clock;

  constructor({
    eventEmitter,
    clock,
    inbox = new InMemoryInbox(),
  }: {
    eventEmitter: IEventEmitter;
    clock: Clock;
    inbox?: Inbox;
  }) {
    this.#eventEmitter = eventEmitter;
    this.#clock = clock;
    this.#inbox = inbox;
  }

  /** Nothing to connect to: the emitter is in this process. */
  async connect() {}

  publish<T>(event: Event<T>, context: ExecutionContext, messageId?: string): IOperation<Event<T>> {
    const operation: IOperation<Event<T>> = {
      id: messageId ?? uuidv4(),
      status: OperationStatus.PENDING,
      event,
      context,
      createdAt: this.#clock(),
      failed: error => {
        operation.status = OperationStatus.ERROR;
        operation.result = Result.fail(error);
        operation.finishedAt = this.#clock();
        return operation;
      },
      success: value => {
        operation.status = OperationStatus.SUCCESS;
        operation.result = Result.ok(value);
        operation.finishedAt = this.#clock();
        return operation;
      },
      sent: () => {
        operation.status = OperationStatus.SENT;
        return operation;
      },
    };

    // The listeners run during emit(): each one that starts a reaction adds it here.
    const reactions: Promise<boolean>[] = [];
    this.#reactions.set(operation, reactions);
    try {
      this.#eventEmitter.emit(event.name, operation);
    } finally {
      this.#reactions.delete(operation);
    }
    operation.delivered = Promise.all(reactions).then(each => each.every(Boolean));

    return operation;
  }

  async subscribe<T>(channel: Event<T>['name'], eventHandler: EventHandler<Event<T>> | CommandHandler<Event<T>>) {
    const place = this.#subscribers.get(channel) ?? 0;
    this.#subscribers.set(channel, place + 1);
    // The subscriber's name is the same in every process that wires the same subscriptions in the same order.
    const subscriber = `${channel}#${place}`;
    // The channel is the event's name: what arrives on it is that event, which the emitter cannot know.
    this.#eventEmitter.addListener(channel, emitted => {
      const operation = emitted as IOperation<Event<T>>;
      // Each subscriber's own verdict: the operation is one for every subscriber, so its status
      // says how the last of them ended, not how this one did. A delivery is the operation, with
      // `failed` noting that this subscriber failed. The reaction is registered now, synchronously,
      // so that the operation's `delivered` waits for it, whether the inbox answers at once or later.
      const reaction = this.#inbox
        .has(subscriber, operation.id)
        .then(async handled => {
          if (handled) {
            operation.sent();
            return true;
          }
          let succeeded = true;
          const delivery: IOperation<Event<T>> = Object.assign(Object.create(operation) as IOperation<Event<T>>, {
            failed: (error: unknown) => {
              succeeded = false;
              return operation.failed(error);
            },
          });
          await eventHandler.handle(delivery).then(
            () => undefined,
            () => {
              succeeded = false;
            },
          );
          if (succeeded) await this.#inbox.record(subscriber, operation.id);
          return succeeded;
        })
        .catch(() => false);
      this.#reactions.get(operation as IOperation<Event<unknown>>)?.push(reaction);
    });
  }
}

/** The inbox of a process: what a subscriber handled, for as long as the process lives. */
export class InMemoryInbox implements Inbox {
  readonly #handled = new Map<string, Set<string>>();

  async has(subscriber: string, messageId: string): Promise<boolean> {
    return this.#handled.get(subscriber)?.has(messageId) ?? false;
  }

  async record(subscriber: string, messageId: string): Promise<void> {
    const handled = this.#handled.get(subscriber) ?? new Set<string>();
    handled.add(messageId);
    this.#handled.set(subscriber, handled);
  }
}
