import { Exception, IResult, Id, NotAllowedException, Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';
import {
  AccountDeletedException,
  AccountSuspendedException,
  convertAtRate,
  GroupArchivedException,
} from '@SharedKernel/Domain';

import type { SettlementMethod, SettlementStatus } from './SettlementBook';
import { FeeBorne, isFeeBorne, ProviderFee } from './ProviderFee';
import { OriginalGiven, OriginalPayment, originalPaymentOf } from './SettlementOriginal';
import {
  ContestPartyNotMemberException,
  InvalidFeePolicyException,
  InvalidSettlementAmountException,
  ProviderFeeUnavailableException,
  PayeeHasNoPayoutAccountException,
  RefundPartyNotMemberException,
  SettlementAlreadyContestedException,
  SettlementMoreThanIsOwedException,
  SettlementMoreThanOwedException,
  SettlementNotContestedException,
  SettlementNotPaidException,
  SettlementNotThroughProviderException,
  SettlementPayeeNotMemberException,
  SettlementPayerNotMemberException,
  SettlementToSelfException,
} from './SettlementExceptions';

/**
 * How much a settlement is: either its amount in the group's currency, or `original`, what is paid in another currency (request 39). A body
 * gives one of the two, never both nor neither: the transport refuses the shape, and the decision refuses it too.
 */
export interface SettlementAmountCommand {
  amount?: number;
  original?: OriginalGiven;
}

/** What a cash settlement says: the payee (the caller, who received the money), the payer, and how much (request 39). */
export interface RecordCashSettlementCommand extends SettlementAmountCommand {
  payee: string;
  from: string;
}

/** What a payment through the provider says: the payer (the caller, who pays), the payee, and how much (request 13, request 39). */
export interface RequestProviderPaymentCommand extends SettlementAmountCommand {
  payer: string;
  to: string;
}

/**
 * What the decision is given (ADR 11, ADR 12): the members of the group, in the order they joined, and what each member still owes
 * or is owed, a member not in the map at 0: the balances the ledger counts, with the payments waiting at the provider counted as paid
 * (`SettlementBook.stillOwed`). The use case read the book before them, so a settlement recorded since moves the version and is refused
 * at the save.
 */
export interface SettlementGiven {
  memberIds: readonly string[];
  balances: ReadonlyMap<string, number>;
  /** Whether the group is archived (request 27): then no settlement is recorded, asked for or refunded in it. */
  archived: boolean;
  /** Whether the caller is suspended (request 34): the payee for a cash settlement, the payer for one through the provider. */
  suspended: boolean;
  /** The group's currency (request 39): what an amount paid in another currency is converted to. */
  groupCurrency: string;
  /**
   * The rate the rates service offers for the original currency to the group's on the day decided, as the use case asked it (request 39);
   * `undefined` when none is offered, or when no other currency is given, which the decision then refuses or does not read.
   */
  offeredRate: string | undefined;
}

/** The values of a settlement once they are allowed: who paid whom, how much in the group's currency, and its original payment, if any. */
export interface NewSettlementValues {
  from: string;
  to: string;
  amount: number;
  original?: OriginalPayment;
}

/**
 * What a payment through the provider is given: the settlement rules' givens, and the payee's payout account at the provider, `undefined`
 * when the payee has none (request 16).
 */
export interface ProviderPaymentGiven extends SettlementGiven {
  payeeAccount: string | undefined;
  /** Whether the payer or the payee is deleted (request 35): then no payment through the provider is asked for between them. */
  deleted: boolean;
}

/**
 * The values of a payment through the provider once allowed: its settlement's id (the provider's reference), who paid whom, how much,
 * and the payee's payout account the provider pays them on (request 16).
 */
export interface NewProviderPaymentValues extends NewSettlementValues {
  id: string;
  payeeAccount: string;
}

/**
 * The rules every settlement is held to, in cash or through the provider (request 12, request 13, ADR 11, ADR 12): the payer and the
 * payee are members of the group and not the same one; the amount is a whole number from 1; it is no more than what the payer owes (the
 * opposite of their balance) and no more than what the payee is owed (their balance), both at the balances given. Answers the first
 * refusal, or none.
 */
function refuseStanding({ archived, suspended }: SettlementGiven): Exception | undefined {
  if (archived) return new GroupArchivedException();
  if (suspended) return new AccountSuspendedException();
  return undefined;
}

/**
 * The amount a settlement is decided in (request 39): the amount given in the group's currency, or the original amount converted at the rate
 * offered for its currency on the day decided, which the settlement keeps. Refused when it gives both or neither, or when the original payment
 * is not allowed (its currency, its amount, or no rate offered), by the name of that rule.
 */
function amountOf(
  given: SettlementGiven,
  { amount, original }: SettlementAmountCommand,
): IResult<{ amount: number; original?: OriginalPayment }> {
  if ((amount === undefined) === (original === undefined)) return Result.fail(new InvalidSettlementAmountException());
  if (original === undefined) return Result.ok({ amount: amount as number });
  const paid = originalPaymentOf({ original, groupCurrency: given.groupCurrency, offeredRate: given.offeredRate });
  if (paid.isFailure()) return paid;
  return Result.ok(paid.data);
}

/**
 * The rules every settlement is held to, in cash or through the provider (request 12, request 13, ADR 11, ADR 12): the payer and the
 * payee are members of the group and not the same one; the amount is a whole number from 1; it is no more than what the payer owes (the
 * opposite of their balance) and no more than what the payee is owed (their balance), both at the balances given. Answers the first
 * refusal, or none.
 */
function refuseSettlement(given: SettlementGiven, { from, to, amount }: NewSettlementValues): Exception | undefined {
  const { memberIds, balances } = given;
  const standing = refuseStanding(given);
  if (standing) return standing;
  if (!memberIds.includes(from)) return new SettlementPayerNotMemberException();
  if (!memberIds.includes(to)) return new SettlementPayeeNotMemberException();
  if (from === to) return new SettlementToSelfException();
  if (!Number.isInteger(amount) || amount < 1) return new InvalidSettlementAmountException();
  if (amount > -(balances.get(from) ?? 0)) return new SettlementMoreThanOwedException();
  if (amount > (balances.get(to) ?? 0)) return new SettlementMoreThanIsOwedException();
  return undefined;
}

/**
 * Recording a settlement in cash (request 12, ADR 11): the rules of `refuseSettlement`, the payee being the caller. Otherwise it is
 * refused and nothing changes. Answers the settlement's values; the use case records it in the book with `SettlementBook.recordCash`.
 */
export const decideRecordCashSettlement: Decision<
  NewSettlementValues,
  RecordCashSettlementCommand,
  never,
  SettlementGiven
> = (given, { payee, from, ...amountCommand }) => {
  const standing = refuseStanding(given);
  if (standing) return Result.fail(standing);
  const paid = amountOf(given, amountCommand);
  if (paid.isFailure()) return paid;
  const refusal = refuseSettlement(given, { from, to: payee, amount: paid.data.amount });
  if (refusal) return Result.fail(refusal);
  return decided({ from, to: payee, ...paid.data });
};

/**
 * Asking to pay through the provider (request 13, ADR 12, request 16): the rules of `refuseSettlement`, the payer being the caller, and the
 * payee must have a payout account at the provider, or the payment is refused by its name and the provider is not asked. The settlement's
 * id is generated here, once (DOMAIN-IDENTITY): it is the reference the provider is given, so the payment can be found again from the
 * book when the provider's webhook says how it ended. Answers the values; the use case asks the provider for a link with them, then
 * records the settlement pending in the book with that link.
 */
export const decideRequestProviderPayment: Decision<
  NewProviderPaymentValues,
  RequestProviderPaymentCommand,
  never,
  ProviderPaymentGiven
> = (given, { payer, to, ...amountCommand }) => {
  const standing = refuseStanding(given);
  if (standing) return Result.fail(standing);
  const paid = amountOf(given, amountCommand);
  if (paid.isFailure()) return paid;
  const refusal = refuseSettlement(given, { from: payer, to, amount: paid.data.amount });
  if (refusal) return Result.fail(refusal);
  if (given.deleted) return Result.fail(new AccountDeletedException());
  if (!given.payeeAccount) return Result.fail(new PayeeHasNoPayoutAccountException());
  return decided({
    id: Id.generate().value,
    from: payer,
    to,
    ...paid.data,
    payeeAccount: given.payeeAccount,
  });
};

/** What the provider's webhook says a payment is, once it has moved: paid, failed, or refunded (request 15). */
export type ProviderOutcome = 'paid' | 'failed' | 'refunded';

/**
 * The outcome a webhook's status settles a payment to (request 13, request 15): `succeeded` is paid, `failed` is failed, `refunded` is
 * refunded; anything else (`pending`, or a status this does not know) changes nothing and answers `undefined`. Pure: it reads no store
 * and no clock.
 */
export function providerOutcomeOf(status: string): ProviderOutcome | undefined {
  if (status === 'succeeded') return 'paid';
  if (status === 'failed') return 'failed';
  if (status === 'refunded') return 'refunded';
  return undefined;
}

/** What a refund is asked by (request 15): the caller, who must be the payee of the settlement. */
export interface RefundSettlementCommand {
  caller: string;
}

/** The settlement a refund is asked of, as the read model has it now, and the members of its group (request 9). */
export interface RefundedSettlementFacts {
  id: string;
  from: string;
  to: string;
  method: SettlementMethod;
  status: SettlementStatus;
}

/** What a refund decision is given: the members of the settlement's group, and the settlement's facts. */
export interface RefundGiven {
  memberIds: readonly string[];
  settlement: RefundedSettlementFacts;
  /** Whether the group is archived (request 27): then no settlement is refunded in it. */
  archived: boolean;
}

/**
 * Refunding a settlement through the provider (request 15, ADR 13): only its payee may, and only while the settlement is `paid` through
 * the provider; a settlement in cash is not refunded through Tally, and one whose payer or payee has left the group (request 9) is not
 * either, so that the balances still add up to 0. Otherwise it is refused and nothing changes. Answers the settlement's id; the use case
 * asks the provider to refund the payment, then the book moves it to refunding.
 */
export const decideRefundSettlement: Decision<{ id: string }, RefundSettlementCommand, never, RefundGiven> = (
  { memberIds, settlement, archived },
  { caller },
) => {
  if (archived) return Result.fail(new GroupArchivedException());
  if (settlement.to !== caller)
    return Result.fail(new NotAllowedException('Settlements', 'Only the payee may refund the settlement'));
  if (settlement.method !== 'provider') return Result.fail(new SettlementNotThroughProviderException());
  if (settlement.status !== 'paid') return Result.fail(new SettlementNotPaidException());
  if (!memberIds.includes(settlement.from) || !memberIds.includes(settlement.to)) {
    return Result.fail(new RefundPartyNotMemberException());
  }
  return decided({ id: settlement.id });
};

/** What a contest is asked by (request 33): the caller, who must be the payee of the settlement. */
export interface ContestSettlementCommand {
  caller: string;
}

/** The settlement a contest is asked of, as the read model has it now: and every status it has had, which says whether it was contested before. */
export interface ContestedSettlementFacts extends RefundedSettlementFacts {
  history: readonly { status: SettlementStatus }[];
}

/** What a contest decision is given: the members of the settlement's group, and the settlement's facts. */
export interface ContestGiven {
  memberIds: readonly string[];
  settlement: ContestedSettlementFacts;
  /** Whether the group is archived (request 27): then no settlement is contested in it. */
  archived: boolean;
}

/**
 * Contesting a settlement (request 33): only its payee may, only a settlement through the provider that is `paid`, only once, and only while
 * its payer and its payee are members of the group. Otherwise it is refused and nothing changes. Answers the settlement's id; the book then
 * moves it to contested.
 */
export const decideContestSettlement: Decision<{ id: string }, ContestSettlementCommand, never, ContestGiven> = (
  { memberIds, settlement, archived },
  { caller },
) => {
  if (archived) return Result.fail(new GroupArchivedException());
  if (settlement.to !== caller)
    return Result.fail(new NotAllowedException('Settlements', 'Only the payee may contest the settlement'));
  if (settlement.method !== 'provider') return Result.fail(new SettlementNotThroughProviderException());
  if (settlement.history.some(line => line.status === 'contested')) {
    return Result.fail(new SettlementAlreadyContestedException());
  }
  if (settlement.status !== 'paid') return Result.fail(new SettlementNotPaidException());
  if (!memberIds.includes(settlement.from) || !memberIds.includes(settlement.to)) {
    return Result.fail(new ContestPartyNotMemberException());
  }
  return decided({ id: settlement.id });
};

/** What an administrator's decision is given: the status the settlement has now. */
export interface DecideContestGiven {
  settlement: { id: string; status: SettlementStatus };
}

/** Deciding a contested settlement (request 33): only a contested one is decided, and once, as it is no longer contested after. */
export const decideDecideContest: Decision<{ id: string }, { paid: boolean }, never, DecideContestGiven> = ({
  settlement,
}) => {
  if (settlement.status !== 'contested') return Result.fail(new SettlementNotContestedException());
  return decided({ id: settlement.id });
};

/** Who bears the provider's fee, as the group's owner decides (request 38): the group, its owner, and whether it is archived. */
export interface FeePolicyGiven {
  ownerId: string | undefined;
  archived: boolean;
}

/** The owner's decision on who bears the provider's fee: the asking account, and the value it names. */
export interface SetFeePolicyCommand {
  caller: string;
  borneBy: string;
}

/**
 * Deciding who bears the provider's fee (request 38): only the group's owner, only while the group is not archived (request 27), and only one
 * of the three. Otherwise it is refused and nothing changes. Answers the policy the book then keeps and records `FeePolicySet`.
 */
export const decideSetFeePolicy: Decision<{ borneBy: FeeBorne }, SetFeePolicyCommand, never, FeePolicyGiven> = (
  { ownerId, archived },
  { caller, borneBy },
) => {
  if (archived) return Result.fail(new GroupArchivedException());
  if (caller !== ownerId)
    return Result.fail(
      new NotAllowedException('Settlements', 'Only the owner of the group may decide who bears the provider fee'),
    );
  if (!isFeeBorne(borneBy)) return Result.fail(new InvalidFeePolicyException());
  return decided({ borneBy });
};

/** The provider's fee for a payment once it has answered: the fee it said, if it said one, the amount, and who bears the fee by the policy. */
export interface ProviderFeeGiven {
  fee: number | undefined;
  /** The amount paid, in the currency the provider was asked for the payment in: the original amount when paid in another currency. */
  amount: number;
  borneBy: FeeBorne;
  /**
   * The conversion of the fee, when the settlement is paid in another currency: the settlement's rate, and the currencies the fee is said in
   * (the original's) and kept in (the group's). The fee is then converted at it, as the amount is (request 39, ADR 38).
   */
  conversion?: { rate: string; from: string; to: string };
}

/**
 * Taking the fee the provider said for a payment (request 38, DOMAIN-NON-DETERMINISM): the fee is kept only when it is a whole number of at
 * least 0 and less than the amount, which the provider gives and the book then keeps with who bears it. A payment without such a fee is
 * refused, and nothing is kept. A fee said in another currency is converted at the settlement's rate, as its amount is, before the payer's
 * part is taken off (request 39): the fee is then in the group's currency, as the settlement's amount is.
 */
export function decideProviderFee({ fee, amount, borneBy, conversion }: ProviderFeeGiven): IResult<ProviderFee> {
  if (fee === undefined || !Number.isInteger(fee) || fee < 0 || fee >= amount) {
    return Result.fail(new ProviderFeeUnavailableException());
  }
  return Result.ok({
    amount: conversion === undefined ? fee : convertAtRate(fee, conversion.rate, conversion.from, conversion.to),
    borneBy,
  });
}
