import { Exception, Id, NotAllowedException, Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';
import { GroupArchivedException } from '@SharedKernel/Domain';

import type { SettlementMethod, SettlementStatus } from './SettlementBook';
import {
  InvalidSettlementAmountException,
  PayeeHasNoPayoutAccountException,
  RefundPartyNotMemberException,
  SettlementMoreThanIsOwedException,
  SettlementMoreThanOwedException,
  SettlementNotPaidException,
  SettlementNotThroughProviderException,
  SettlementPayeeNotMemberException,
  SettlementPayerNotMemberException,
  SettlementToSelfException,
} from './SettlementExceptions';

/** What a cash settlement says: the payee (the caller, who received the money), the payer, and the amount. */
export interface RecordCashSettlementCommand {
  payee: string;
  from: string;
  amount: number;
}

/** What a payment through the provider says: the payer (the caller, who pays), the payee, and the amount (request 13). */
export interface RequestProviderPaymentCommand {
  payer: string;
  to: string;
  amount: number;
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
}

/** The values of a settlement once they are allowed: who paid whom, how much. */
export interface NewSettlementValues {
  from: string;
  to: string;
  amount: number;
}

/**
 * What a payment through the provider is given: the settlement rules' givens, and the payee's payout account at the provider, `undefined`
 * when the payee has none (request 16).
 */
export interface ProviderPaymentGiven extends SettlementGiven {
  payeeAccount: string | undefined;
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
function refuseSettlement(
  { memberIds, balances, archived }: SettlementGiven,
  { from, to, amount }: NewSettlementValues,
): Exception | undefined {
  if (archived) return new GroupArchivedException();
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
> = (given, { payee, from, amount }) => {
  const refusal = refuseSettlement(given, { from, to: payee, amount });
  if (refusal) return Result.fail(refusal);
  return decided({ from, to: payee, amount });
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
> = (given, { payer, to, amount }) => {
  const refusal = refuseSettlement(given, { from: payer, to, amount });
  if (refusal) return Result.fail(refusal);
  if (!given.payeeAccount) return Result.fail(new PayeeHasNoPayoutAccountException());
  return decided({ id: Id.generate().value, from: payer, to, amount, payeeAccount: given.payeeAccount });
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
