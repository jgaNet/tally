import { Id } from '@Architecture/Domain';

/**
 * One settlement, as the book records it: `payer` paid `payee` the `amount` of a group, in cash, at `at`. It is decided by the
 * book (`SettlementBook.recordCash`) and never changed afterwards; its status is `paid` from the moment it is recorded.
 */
export class Settlement {
  readonly method = 'cash' as const;
  readonly status = 'paid' as const;

  constructor(
    readonly id: Id,
    readonly groupId: Id,
    readonly payer: Id,
    readonly payee: Id,
    readonly amount: number,
    readonly at: Date,
  ) {}
}
