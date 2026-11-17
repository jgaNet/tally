import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { suggestTransfers, SuggestedTransfer } from '@Contexts/Settlements/Domain/Suggestion/SuggestedTransfers';
import { ISettlementQueries, SettlementView } from '@Contexts/Settlements/Domain/ISettlementQueries';
import { stillOwed } from '@Contexts/Settlements/Domain/SettlementBook/StillOwed';
import {
  decideRecordCashSettlement,
  decideRefundSettlement,
  decideRequestProviderPayment,
  providerOutcomeOf,
} from '@Contexts/Settlements/Domain/SettlementBook/SettlementBook.decision';
import {
  ProviderRefundUnavailableException,
  ProviderUnavailableException,
} from '@Contexts/Settlements/Domain/SettlementBook/SettlementExceptions';

import { IGroupBalances } from './IGroupBalances';
import { IPaymentProvider } from './IPaymentProvider';
import { ISettlementBooks } from './ISettlementBooks';
import { ISettlementMembers } from './ISettlementMembers';

/**
 * A member of a group reads the transfers that would bring every balance of the group to 0 (request 11), made by the stated
 * algorithm, in the order they are made. What is still owed counts the payments waiting at the provider as paid (ADR 12). Reading
 * them changes nothing and records nothing. Anyone who is not a member gets the answer for a group that does not exist.
 */
export const getSuggestedSettlements = query(
  'GetSuggestedSettlements',
  (groupBalances: IGroupBalances, members: ISettlementMembers, queries: ISettlementQueries) =>
    async ({ id }: { id: string }, context) => {
      const memberIds = await members.membersOf(id, callerOf(context));
      if (!memberIds) return Result.fail(new NotFoundException('Settlements', 'No group is found'));
      const balances = stillOwed(await groupBalances.balancesOf(id), await queries.pendingOf(id));
      const transfers: SuggestedTransfer[] = suggestTransfers(
        memberIds.map(memberId => ({ memberId, balance: balances.get(memberId) ?? 0 })),
      );
      return Result.ok(transfers);
    },
);

/** What a member records: the group, the payer (its account id), and the amount paid in cash to the caller. */
export interface RecordCashSettlementInput {
  groupId: string;
  from: string;
  amount: number;
}

/**
 * A member of a group records a payment in cash they received from another member of the group (request 12): the caller is the
 * payee, the payer is `from`. It is decided in the group's settlement book on the balances as they are now, which count every
 * settlement already recorded and every payment waiting at the provider, and refused if it is more than the payer owes or the payee
 * is owed (ADR 11, ADR 12). Two recorded at once are decided one after the other: the second is re-read and decided again by the
 * book's version check. Answers the new settlement's id. Anyone who is not a member gets the answer for a group that does not exist.
 */
export const recordCashSettlement = command(
  'RecordCashSettlement',
  (books: ISettlementBooks, groupBalances: IGroupBalances, members: ISettlementMembers, clock: Clock) =>
    async ({ groupId, from, amount }: RecordCashSettlementInput, context) => {
      const payee = callerOf(context);
      const memberIds = await members.membersOf(groupId, payee);
      if (!memberIds) return Result.fail(new NotFoundException('Settlements', 'No group is found'));

      // The book is read before the balances: a settlement recorded after this read moves the version, so the save refuses this
      // decision and the retry reads the balances again; a settlement recorded before it is in the balances read below.
      const book = await books.bookOf(groupId);
      const balances = book.stillOwed(await groupBalances.balancesOf(groupId));
      const now = clock();
      const decision = decideRecordCashSettlement({ memberIds, balances }, { payee, from, amount }, now);
      if (decision.isFailure()) return decision;

      const settlementId = book.recordCash({ ...decision.data.state, at: now });
      await books.save(book);
      await publishDomainEvents(book, context);
      return Result.ok(settlementId);
    },
);

/** What a member asks to pay through the provider: the group, the payee (its account id), and the amount (request 13). */
export interface PayThroughProviderInput {
  groupId: string;
  to: string;
  amount: number;
}

/**
 * A member of a group asks to pay another member of it through the payment provider (request 13): the caller is the payer. The rules
 * are the cash settlement's, on what is still owed (ADR 12). The provider is asked for a link for the settlement's id as reference and
 * the group's currency, within its limit; when it gives none, the request is refused and nothing is kept. Otherwise the book records the
 * settlement pending, with the link, and the save checks that nothing else was decided since the book was read: a payment that two
 * requests at once would make too much is refused by the same rule, and its orphan payment at the provider is never paid. Answers the
 * settlement's id, which the payer's link carries.
 */
export const payThroughProvider = command(
  'PayThroughProvider',
  (
    books: ISettlementBooks,
    groupBalances: IGroupBalances,
    members: ISettlementMembers,
    provider: IPaymentProvider,
    clock: Clock,
  ) =>
    async ({ groupId, to, amount }: PayThroughProviderInput, context) => {
      const payer = callerOf(context);
      const memberIds = await members.membersOf(groupId, payer);
      if (!memberIds) return Result.fail(new NotFoundException('Settlements', 'No group is found'));
      const currency = await members.currencyOf(groupId, payer);
      if (currency === undefined) return Result.fail(new NotFoundException('Settlements', 'No group is found'));

      // As the cash settlement: the book is read before the balances, so a decision made on a state another request changed is refused at save.
      const book = await books.bookOf(groupId);
      const balances = book.stillOwed(await groupBalances.balancesOf(groupId));
      const now = clock();
      const decision = decideRequestProviderPayment({ memberIds, balances }, { payer, to, amount }, now);
      if (decision.isFailure()) return decision;

      const payment = decision.data.state;
      const link = await provider.paymentLinkFor({ reference: payment.id, amount: payment.amount, currency });
      if (!link) return Result.fail(new ProviderUnavailableException());

      // The book records the payment with the link in hand; the save refuses it if the book moved since it was read.
      book.requestPayment({ ...payment, at: now, providerPaymentId: link.id, payUrl: link.payUrl });
      await books.save(book);
      await publishDomainEvents(book, context);
      return Result.ok(payment.id);
    },
);

/** What the provider's webhook says about a payment: its id at the provider, and its status (request 13). */
export interface PaymentWebhookInput {
  paymentId: string;
  status: string;
}

/**
 * The provider's signed webhook about a payment (request 13, ADR 12): anyone may send it (the signature is the proof, checked before this
 * runs, at the transport). A payment waiting under the id is paid when the provider says `succeeded` and failed when it says `failed`;
 * any other status, a payment not waiting (already settled, or never known to Tally) changes nothing. Answers nothing, which the transport
 * acknowledges with a 2xx whatever it says, so the provider stops sending it.
 */
export const receivePaymentWebhook = command(
  'ReceivePaymentWebhook',
  (books: ISettlementBooks) =>
    async ({ paymentId, status }: PaymentWebhookInput, context) => {
      const outcome = providerOutcomeOf(status);
      const book = await books.bookOfPayment(paymentId);
      if (!outcome || !book) return Result.ok(undefined);

      book.settlePayment(paymentId, outcome);
      await books.save(book);
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
  { caller: 'anyone' },
);

/** What a member asks to refund: the settlement's id (request 15). */
export interface RefundSettlementInput {
  id: string;
}

/**
 * The payee of a settlement paid through the provider refunds it, whole (request 15, ADR 13). The book is read first, then the settlement
 * and the members of its group, so a change to the settlement since the book was read moves the book's version and the save refuses this
 * decision (CONC-OPTIMISTIC). The decision allows it only for the payee, while the settlement is `paid` through the provider and both
 * its payer and payee are still members; the provider is then asked to refund the payment, within its limit, and when it does not
 * accept, the request is refused and nothing changes. Otherwise the book moves the settlement to `refunding`, where the balances still
 * count it, until the provider's webhook says it is refunded. A payment the provider has refunded before this request is never refunded
 * twice here: the book no longer holds it as paid. Answers nothing (`204`). Anyone who is not a member gets the answer for a settlement
 * that does not exist.
 */
export const refundSettlement = command(
  'RefundSettlement',
  (
    books: ISettlementBooks,
    settlements: ISettlementQueries,
    members: ISettlementMembers,
    provider: IPaymentProvider,
    clock: Clock,
  ) =>
    async ({ id }: RefundSettlementInput, context) => {
      const payee = callerOf(context);
      // The book is read before the settlement and the members: as the other decisions, a change after this read moves the version.
      const book = await books.bookOfSettlement(id);
      if (!book) return Result.fail(new NotFoundException('Settlements', 'No settlement is found'));
      const settlement = await settlements.settlementOf(id);
      if (!settlement) return Result.fail(new NotFoundException('Settlements', 'No settlement is found'));
      const memberIds = await members.membersOf(book.groupId, payee);
      if (!memberIds) return Result.fail(new NotFoundException('Settlements', 'No settlement is found'));

      const decision = decideRefundSettlement({ memberIds, settlement }, { caller: payee }, clock());
      if (decision.isFailure()) return decision;

      // A paid settlement is held by the book, with the provider's id for it: a settlement the book does not hold is not one it can refund.
      const paymentId = book.providerPaymentOf(id);
      if (paymentId === undefined) throw new Error(`The paid settlement ${id} is not held by its book`);
      // The provider is asked outside the write; a refusal keeps nothing.
      if (!(await provider.refundPayment({ paymentId, reference: id }))) {
        return Result.fail(new ProviderRefundUnavailableException());
      }

      book.requestRefund(id);
      await books.save(book);
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
);

/**
 * A member of the settlement's group reads it; anyone else, or nobody, gets the answer for a settlement that does not exist. It
 * says how the settlement is paid and where it stands, and, through the provider, the link where the payer pays (request 13).
 */
export const getSettlement = query(
  'GetSettlement',
  (settlements: ISettlementQueries, members: ISettlementMembers) =>
    async ({ id }: { id: string }, context) => {
      const settlement: SettlementView | undefined = await settlements.settlementOf(id);
      if (!settlement) return Result.fail(new NotFoundException('Settlements', 'No settlement is found'));
      if (!(await members.membersOf(settlement.groupId, callerOf(context)))) {
        return Result.fail(new NotFoundException('Settlements', 'No settlement is found'));
      }
      return Result.ok(settlement);
    },
);
