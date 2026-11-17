import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';

import { UnknownPayoutAccountException } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccountExceptions';

/** The provider's answer about an account it knows: its id, as the provider names it (`200 { id }`). */
export interface ProviderPayoutAccount {
  readonly id: string;
}

export type PayoutAccountSetPayload = {
  payoutAccountId: string;
  ownerId: string;
  providerAccountId: string;
  at: string;
};

/** A person set the payout account the provider pays them on (request 16): nothing reacts to it yet. */
export class PayoutAccountSetEvent extends DomainEvent<PayoutAccountSetPayload> {}

/**
 * The account at the payment provider a person is paid on (request 16, conventions/domain.yaml, ADR 11): one per person, its identity
 * generated when it is first set, and replaced, not added to, when the person sets another. It keeps the owner's account id and the
 * provider's id of the account, which the provider must know: an account it does not know is refused, and nothing is set.
 *
 * The aggregate never asks the provider: the caller passes the provider's answer (`undefined` when it gave none), and the account
 * takes it or refuses it (DOMAIN-NON-DETERMINISM). The time is `now`.
 */
export class PayoutAccount extends AggregateRoot {
  readonly #ownerId: string;
  #providerAccountId: string;

  private constructor(id: Id, version: number, ownerId: string, providerAccountId: string) {
    super(id, version);
    this.#ownerId = ownerId;
    this.#providerAccountId = providerAccountId;
  }

  /** The account of the owner, once the provider has been asked: refused, and nothing created, unless the provider knows it. */
  static create(
    { ownerId, providerAccount }: { ownerId: string; providerAccount: ProviderPayoutAccount | undefined },
    now: Date,
  ): IResult<PayoutAccount> {
    if (!providerAccount?.id) return Result.fail(new UnknownPayoutAccountException());
    const account = new PayoutAccount(Id.generate(), 0, ownerId, providerAccount.id);
    account.record(
      PayoutAccountSetEvent.set({
        payoutAccountId: account._id.value,
        ownerId,
        providerAccountId: providerAccount.id,
        at: now.toISOString(),
      }),
    );
    return Result.ok(account);
  }

  /** Reads an account as it was saved. Records nothing. */
  static fromSnapshot({
    id,
    version,
    ownerId,
    providerAccountId,
  }: {
    id: string;
    version: number;
    ownerId: string;
    providerAccountId: string;
  }): PayoutAccount {
    if (!id || !ownerId || !providerAccountId)
      throw new Error('A payout account is read with its id, owner and account');
    return new PayoutAccount(new Id(id), version, ownerId, providerAccountId);
  }

  /** Replaces the provider's account of this one, refused and unchanged unless the provider knows the new one. */
  set(providerAccount: ProviderPayoutAccount | undefined, now: Date): IResult<void> {
    if (!providerAccount?.id) return Result.fail(new UnknownPayoutAccountException());
    this.#providerAccountId = providerAccount.id;
    this.record(
      PayoutAccountSetEvent.set({
        payoutAccountId: this._id.value,
        ownerId: this.#ownerId,
        providerAccountId: providerAccount.id,
        at: now.toISOString(),
      }),
    );
    return Result.ok(undefined);
  }

  /** The account id of the person this is the payout account of. */
  get ownerId(): string {
    return this.#ownerId;
  }

  /** The provider's id of the account the person is paid on. */
  get providerAccountId(): string {
    return this.#providerAccountId;
  }
}
