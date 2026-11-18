/**
 * The inbox (ADR 12): what each subscriber has handled, by the subscription and the message's id, kept in the
 * database with the writes the handling made. A fact relayed from the outbox is handed out again until it is
 * acknowledged, so a server that stops after a reaction committed, and before the relay acknowledged it, hands
 * the same fact to the same subscriber again when it starts. The inbox is what makes that second hand-out a
 * no-op: the reaction's `has()` answers yes, and the reaction does nothing twice.
 *
 * Both calls run inside the reaction's transaction (`EventHandler.handle()`): `has()` before the reaction,
 * `record()` as the last step before the commit, so the mark and the reaction's writes are durable together or
 * not at all. A subscription is named by the handler's class and the event's name, which survive a restart.
 *
 * Implementations: Infrastructure/Postgres/PostgresInbox.ts (the database's, over the same file as the outbox) and
 * Infrastructure/Inbox/InMemoryInbox.ts (a store the in-memory unit of work snapshots and restores with the others).
 */
export interface Inbox {
  /** Whether the subscription has handled the message in a transaction that committed. */
  has(subscription: string, messageId: string): Promise<boolean>;
  /** Remembers that the subscription handled the message: called inside the reaction's transaction. */
  record(subscription: string, messageId: string): Promise<void>;
}
