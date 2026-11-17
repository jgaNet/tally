import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { PayoutAccountSetEvent } from '@Contexts/Settlements/Domain/PayoutAccount/Events/PayoutAccountEvents';
import { UnknownPayoutAccountException } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccountExceptions';

/**
 * The payout account of one person (request 16, docs/adr/0016): the provider's id of the account the provider pays the person on,
 * which the provider must know. The person's identity is its identity: the account's id, born with the account and taken up as it is
 * (DOMAIN-IDENTITY), as a settlement book's is its group's. Its version is what a save checks (CONC-OPTIMISTIC).
 *
 * `set()` decides with the provider's answer in hand: the answer is the id it knows for the account asked, or none when it does not
 * know it. An account the provider does not know is refused (`UnknownPayoutAccount`) and nothing changes; one it knows replaces the
 * account the person had, as `PayoutAccountSet`. A person with no payout account is at version 0 with none.
 *
 * `fromSnapshot()` reads what the store kept, records nothing, and throws on corrupted data.
 */
export class PayoutAccount extends AggregateRoot {
  #providerAccountId: string | undefined;

  private constructor(accountId: Id, version: number, providerAccountId: string | undefined) {
    super(accountId, version);
    this.#providerAccountId = providerAccountId;
  }

  /** The account as the store kept it, at the version it was read at: 0 with no provider account when the person has none. */
  static fromSnapshot({
    accountId,
    version,
    providerAccountId,
  }: {
    accountId: string;
    version: number;
    providerAccountId?: string;
  }): PayoutAccount {
    const corrupted =
      !accountId ||
      !Number.isInteger(version) ||
      version < 0 ||
      (providerAccountId === undefined ? version !== 0 : !providerAccountId || version === 0);
    if (corrupted) {
      throw new Error(`A payout account is corrupted: account ${accountId}, version ${version}`);
    }
    return new PayoutAccount(new Id(accountId), version, providerAccountId);
  }

  get accountId(): string {
    return this._id.value;
  }

  /** The provider's id of the account the person is paid on, or `undefined` when the person has none. */
  get providerAccountId(): string | undefined {
    return this.#providerAccountId;
  }

  /**
   * Sets the payout account to `providerAccountId`, the answer the provider gave for it: `known` is the id it knows the account by, or
   * `undefined` when it does not know it. Refused (`UnknownPayoutAccount`) unless the provider knows exactly the account asked for.
   */
  set({ providerAccountId, known }: { providerAccountId: string; known: string | undefined }): IResult<undefined> {
    if (!providerAccountId || known !== providerAccountId) {
      return Result.fail(new UnknownPayoutAccountException());
    }
    this.#providerAccountId = providerAccountId;
    this.record(PayoutAccountSetEvent.set({ accountId: this.accountId, providerAccountId }));
    return Result.ok(undefined);
  }
}
