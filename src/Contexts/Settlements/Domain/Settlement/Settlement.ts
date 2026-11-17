/**
 * A settlement, as the domain records it (request 12, conventions/domain.yaml): one transfer in cash from a payer to a payee of a
 * group, whole in the group's currency's hundredths, at least 1, and recorded when it was decided. It is a value: once recorded,
 * it is kept as it is, and what it does to the balances is read from it (ADR 10), never written back.
 */
export interface Settlement {
  readonly id: string;
  readonly groupId: string;
  /** The payer: the member who paid the money. */
  readonly from: string;
  /** The payee: the member who received it, and who recorded it. */
  readonly to: string;
  readonly amount: number;
  readonly method: 'cash';
  readonly status: 'paid';
  /** When it was recorded, as an ISO 8601 instant. */
  readonly at: string;
}
