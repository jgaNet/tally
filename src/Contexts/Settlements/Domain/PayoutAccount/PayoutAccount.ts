import { AggregateRoot, Exception, Id, IResult, Result } from '@Architecture/Domain';
import { PayoutAccountSetEvent } from '@Contexts/Settlements/Domain/PayoutAccount/Events/PayoutAccountEvents';
import { UnknownPayoutAccount } from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/**
 * A person's payout account (request 16, ADR 10): the provider's id of the account the provider pays the person on. The
 * provider decides whether it knows the account; the aggregate takes its answer or refuses it, and an account the provider
 * does not know, or answers for another id, is never kept. A person has one payout account: setting another replaces it.
 */
export class PayoutAccount extends AggregateRoot {
  #accountId: string;

  private constructor(
    id: Id,
    version: number,
    readonly owner: Id,
    accountId: string,
  ) {
    super(id, version);
    this.#accountId = accountId;
  }

  /** The provider's id of the account the person is paid on. */
  get accountId(): string {
    return this.#accountId;
  }

  /**
   * A person sets their first payout account, on the provider's answer: the account it knows, or null for one it does not. The
   * id is generated here; PayoutAccountSet is recorded.
   */
  static create({
    owner,
    accountId,
    providerAnswer,
  }: {
    owner: Id;
    accountId: string;
    providerAnswer: { id: string } | null;
  }): IResult<PayoutAccount> {
    const refusal = refusalOf(accountId, providerAnswer);
    if (refusal) return Result.fail(refusal);
    const account = new PayoutAccount(Id.generate(), 0, owner, accountId);
    account.record(PayoutAccountSetEvent.set({ payoutAccountId: account._id.value, owner: owner.value, accountId }));
    return Result.ok(account);
  }

  /** The person replaces the payout account they had, on the provider's answer; PayoutAccountSet is recorded. */
  change({ accountId, providerAnswer }: { accountId: string; providerAnswer: { id: string } | null }): IResult {
    const refusal = refusalOf(accountId, providerAnswer);
    if (refusal) return Result.fail(refusal);
    this.#accountId = accountId;
    this.record(PayoutAccountSetEvent.set({ payoutAccountId: this._id.value, owner: this.owner.value, accountId }));
    return Result.ok();
  }

  /** The payout account as it is stored: it records nothing. */
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
    if (!id || !owner || !accountId) throw new Error(`Corrupted payout account ${id}`);
    return new PayoutAccount(new Id(id), version, new Id(owner), accountId);
  }
}

/** The refusal of an account the provider does not know, or that it answered for another id: none, or UnknownPayoutAccount. */
function refusalOf(accountId: string, providerAnswer: { id: string } | null): Exception | undefined {
  if (!accountId || providerAnswer === null || providerAnswer.id !== accountId) return new UnknownPayoutAccount();
  return undefined;
}
