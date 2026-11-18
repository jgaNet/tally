import { v4 as uuidv4 } from 'uuid';

import { Event, Result } from '@Architecture/Domain';
import {
  Clock,
  CommandHandler,
  EventBus,
  EventHandler,
  ExecutionContext,
  IEventEmitter,
  IOperation,
  OperationStatus,
} from '@Architecture/Application';

/**
 * What each subscriber has handled: the inbox (ADR 24). `has` and `add` are asynchronous, so that the inbox can be a table (see
 * PostgresInbox); the bus's own default keeps it in memory.
 */
export interface Inbox {
  has(subscriber: string, messageId: string): Promise<boolean>;
  add(subscriber: string, messageId: string): Promise<void>;
}

/** An inbox in memory: the default of a bus built without one (specs, and the unit tests of the building blocks). */
export class MemoryInbox implements Inbox {
  readonly #seen = new Map<string, Set<string>>();

  async has(subscriber: string, messageId: string): Promise<boolean> {
    return this.#seen.get(subscriber)?.has(messageId) ?? false;
  }

  async add(subscriber: string, messageId: string): Promise<void> {
    const seen = this.#seen.get(subscriber) ?? new Set<string>();
    seen.add(messageId);
    this.#seen.set(subscriber, seen);
  }
}

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
  #inbox: Inbox;
  /** How many subscriptions each channel and handler class had: a subscriber's name in the inbox, stable across restarts. */
  #subscriptionsNamed = new Map<string, number>();
  /** While a message is emitted, the reactions it starts: what its `delivered` waits for. */
  #reactions = new Map<IOperation<Event<unknown>>, Promise<boolean>[]>();
  /** When an operation was created and finished: the application's clock (DOMAIN-ONE-CLOCK). */
  #clock: Clock;

  constructor({
    eventEmitter,
    clock,
    inbox = new MemoryInbox(),
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
    const named = `${channel}|${eventHandler.constructor.name}`;
    const occurrence = this.#subscriptionsNamed.get(named) ?? 0;
    this.#subscriptionsNamed.set(named, occurrence + 1);
    const subscriber = `${named}#${occurrence}`;
    // The channel is the event's name: what arrives on it is that event, which the emitter cannot know.
    this.#eventEmitter.addListener(channel, emitted => {
      const operation = emitted as IOperation<Event<T>>;
      const reaction = this.#deliver(subscriber, operation, eventHandler);
      this.#reactions.get(operation as IOperation<Event<unknown>>)?.push(reaction);
    });
  }

  /** One subscriber's delivery of one message: handed out unless its inbox has it, and recorded there once it succeeded. */
  async #deliver<T>(
    subscriber: string,
    operation: IOperation<Event<T>>,
    eventHandler: EventHandler<Event<T>> | CommandHandler<Event<T>>,
  ): Promise<boolean> {
    if (await this.#inbox.has(subscriber, operation.id)) {
      operation.sent();
      return true;
    }
    // Each subscriber's own verdict: the operation is one for every subscriber, so its status
    // says how the last of them ended, not how this one did. A delivery is the operation, with
    // `failed` noting that this subscriber failed.
    let succeeded = true;
    const delivery: IOperation<Event<T>> = Object.assign(Object.create(operation) as IOperation<Event<T>>, {
      failed: (error: unknown) => {
        succeeded = false;
        return operation.failed(error);
      },
    });
    try {
      await eventHandler.handle(delivery);
    } catch {
      return false;
    }
    if (!succeeded) return false;
    await this.#inbox.add(subscriber, operation.id);
    return true;
  }
}
