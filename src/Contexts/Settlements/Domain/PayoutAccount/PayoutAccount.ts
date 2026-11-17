import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { IPayoutAccountSnapshot } from '@Contexts/Settlements/Domain/PayoutAccount/DTOs';
import { PayoutAccountSetEvent } from '@Contexts/Settlements/Domain/PayoutAccount/Events/PayoutAccountEvents';
import { UnknownPayoutAccountException } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccountExceptions';
import { ProviderUnavailableException } from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/**
 * PayoutAccount is the aggregate root of one member's payout account: the provider's id of the account the provider pays
 * them on (request 16, the storm `payout-accounts`, decided with the product's owner). One per member; setting another
 * replaces the one held.
 *
 * The provider is the one that knows whether it knows an account, so its answer arrives as a plain value the aggregate
 * takes or refuses (DOMAIN-NON-DETERMINISM): true when it knows the account, false when it does not (UnknownPayoutAccount),
 * and null when it did not answer as asked, or not within 5 seconds (ProviderUnavailable). Nothing is kept on a refusal.
 */
export class PayoutAccount extends AggregateRoot {
  readonly #owner: string;
  #accountId: string | null;

  private constructor(id: Id, owner: string, accountId: string | null, version: number) {
    super(id, version);
    this.#owner = owner;
    this.#accountId = accountId;
  }

  /** The payout account of a member who has none yet: its id is generated here, and nothing is recorded until it is set. */
  static open(owner: string): PayoutAccount {
    return new PayoutAccount(Id.generate(), owner, null, 0);
  }

  /** The payout account as the store holds it. Records nothing: nothing new happened. */
  static fromSnapshot({ _id, owner, accountId, version }: IPayoutAccountSnapshot): PayoutAccount {
    return new PayoutAccount(new Id(_id), owner, accountId, version);
  }

  /**
   * Sets the account the member is paid on, to the one the provider answered about: `providerAnswer` is whether the provider
   * knows `accountId`. Records `PayoutAccountSet` when it is kept; a refusal changes nothing.
   */
  set({ accountId, providerAnswer }: { accountId: string; providerAnswer: boolean | null }): IResult<void> {
    if (!accountId) return Result.fail(new UnknownPayoutAccountException());
    if (providerAnswer === null) return Result.fail(new ProviderUnavailableException());
    if (!providerAnswer) return Result.fail(new UnknownPayoutAccountException());

    this.#accountId = accountId;
    this.record(PayoutAccountSetEvent.set({ owner: this.#owner, accountId }));
    return Result.ok();
  }

  get owner(): string {
    return this.#owner;
  }

  /** The provider's id of the account the member is paid on, or null while none is set. */
  get accountId(): string | null {
    return this.#accountId;
  }

  toSnapshot(): IPayoutAccountSnapshot {
    return { _id: this._id.value, owner: this.#owner, accountId: this.#accountId, version: this.version };
  }
}
