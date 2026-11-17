import { AggregateRoot, Id } from '@Architecture/Domain';

import { PayoutAccountSetEvent } from './PayoutAccountEvents';

/** A payout account as it is stored: whose it is, and the provider's id of the account the provider pays them on, at its version. */
export interface PayoutAccountSnapshot {
  id: string;
  ownerId: string;
  accountId: string;
  version: number;
}

/**
 * The payout account of one person: the provider's id of the account the provider pays them on (request 16, ADR 12). One per person:
 * setting another replaces it. Its own identity is generated here, once, when it is first set; it carries the version it was read at
 * (CONC-OPTIMISTIC), and its store checks that version when it is saved. Its rules are the decision's
 * (`PayoutAccount.decision.ts`): the provider must know the account, which the decision is given.
 */
export class PayoutAccount extends AggregateRoot {
  readonly #ownerId: string;
  #accountId: string;

  private constructor(id: Id, version: number, ownerId: string, accountId: string) {
    super(id, version);
    this.#ownerId = ownerId;
    this.#accountId = accountId;
  }

  /** A payout account set for the first time: its id generated here, recording that it was set. */
  static create({ ownerId, accountId }: { ownerId: string; accountId: string }): PayoutAccount {
    const account = new PayoutAccount(Id.generate(), 0, ownerId, accountId);
    account.record(PayoutAccountSetEvent.set({ ownerId, accountId }));
    return account;
  }

  /** Rebuilds the payout account as it is stored, at the version it was stored at. Records nothing; throws on a version no save could store. */
  static fromSnapshot({ id, ownerId, accountId, version }: PayoutAccountSnapshot): PayoutAccount {
    if (!Number.isInteger(version) || version < 1) throw new Error(`The stored payout account ${id} is corrupted`);
    return new PayoutAccount(new Id(id), version, ownerId, accountId);
  }

  get payoutAccountId(): string {
    return this._id.value;
  }

  get ownerId(): string {
    return this.#ownerId;
  }

  /** The provider's id of the account the provider pays the owner on. */
  get accountId(): string {
    return this.#accountId;
  }

  /** Replaces the account with another the provider knows, whose values the decision has allowed; records that it was set. */
  replaceWith(accountId: string): void {
    this.#accountId = accountId;
    this.record(PayoutAccountSetEvent.set({ ownerId: this.#ownerId, accountId }));
  }
}
