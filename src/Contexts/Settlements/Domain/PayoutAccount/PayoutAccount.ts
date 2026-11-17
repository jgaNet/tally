import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { PayoutAccountSetEvent } from '@Contexts/Settlements/Domain/PayoutAccount/Events/PayoutAccountEvents';
import { UnknownPayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccountExceptions';

/**
 * The provider's answer about one account: the id it knows the account under. A null answer is no answer at all: the provider did
 * not know the account, did not answer as its API says, or did not answer within its limit.
 */
export interface KnownPayoutAccount {
  readonly id: string;
}

/**
 * The payout account of one person: the provider's id of the account the provider pays them on (the storm's decision: Settlements
 * owns it, one per person, because only paying through the provider needs it). The provider is the one that knows the account, so
 * the account is set only from the provider's answer, and replaced by another one when set again.
 */
export class PayoutAccount extends AggregateRoot {
  private constructor(
    id: Id,
    readonly owner: Id,
    private account: string | null,
    version: number,
  ) {
    super(id, version);
  }

  /** The payout account of a person who has none yet: it has no account until one is set. */
  static open(owner: Id): PayoutAccount {
    return new PayoutAccount(Id.generate(), owner, null, 0);
  }

  /** The payout account as it is kept, at the version it was read at; it records nothing. */
  static fromSnapshot({
    id,
    owner,
    accountId,
    version,
  }: {
    id: string;
    owner: string;
    accountId: string;
    version: number;
  }): PayoutAccount {
    return new PayoutAccount(new Id(id), new Id(owner), accountId, version);
  }

  /** The provider's id of the payout account, or null when the person has not set one. */
  get accountId(): string | null {
    return this.account;
  }

  /**
   * Sets the account the person is paid on, to the one the provider knows (`known`, its answer for `accountId`). An account the
   * provider does not know, or whose answer names another id, is refused and nothing changes.
   */
  set(accountId: string, known: KnownPayoutAccount | null): IResult<void> {
    if (!accountId || !known || known.id !== accountId) return Result.fail(new UnknownPayoutAccount());

    this.account = accountId;
    this.record(PayoutAccountSetEvent.set({ owner: this.owner.value, accountId }));
    return Result.ok();
  }
}
