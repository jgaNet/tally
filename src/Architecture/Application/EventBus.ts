/**
 * EventBus: publishes events and routes them to the handlers subscribed to their name.
 *
 * Publishing returns an Operation: a handle on the asynchronous processing of that event,
 * which the Tracker context records so a client can poll `GET /v1/tracker/operations/:id`.
 *
 * Implementations: Infrastructure/EventBus/InMemoryEventBus.ts (plain in-process emitter)
 * and Contexts/Tracker/Infrastructure/TrackedEventBus.ts (a decorator that records every operation).
 */

import { Event } from '@Architecture/Domain';
import { EventHandler } from '@Architecture/Application/EventHandler';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { IOperation } from '@Architecture/Application/Operation';

/**
 * The bus's record of what it delivered (ADR 24, docs/adr/0029): per subscriber, the ids of the messages it handled and
 * did not fail. It is durable where the bus is: a relay after a restart does not hand a subscriber a message it has
 * already handled.
 */
export interface Inbox {
  has(subscriber: string, messageId: string): Promise<boolean>;
  record(subscriber: string, messageId: string): Promise<void>;
}

export interface EventBus {
  /**
   * Connects to the event infrastructure (if needed)
   */
  connect(): Promise<void>;

  /**
   * Publishes an event to the event bus
   * @param event The event to dispatch
   * @param context The execution context of the caller, carried to the handlers
   * @param messageId The message's id when the event is relayed from the outbox (its entry's id): a
   * subscriber that already handled it is not handed it again (ADR 24). A fresh id otherwise.
   * @returns The operation tracking the event
   */
  publish<T>(event: Event<T>, context: ExecutionContext, messageId?: string): IOperation<Event<T>>;

  /**
   * Subscribes to an event
   * @param event The event name to subscribe to
   * @param eventHandler The handler for the event
   */
  subscribe<T>(event: Event<T>['name'], eventHandler: EventHandler<Event<T>>): Promise<void>;
}
