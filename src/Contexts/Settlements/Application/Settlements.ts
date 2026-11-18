import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { AccountDeletedException } from '@SharedKernel/Domain';

import { IGroupBalances } from '@Contexts/Settlements/Application/IGroupBalances';
import { IPaymentProvider } from '@Contexts/Settlements/Application/IPaymentProvider';
import { IPayoutAccountStore } from '@Contexts/Settlements/Application/IPayoutAccountStore';
import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';
import { ISettlementStore, SettlementView } from '@Contexts/Settlements/Application/ISettlementStore';
import { ISettlementAuditLog } from '@Contexts/Settlements/Application/ISettlementAuditLog';
import { IWebhookSignature } from '@Contexts/Settlements/Application/IWebhookSignature';
import { openBook } from '@Contexts/Settlements/Application/OpenBook';
import { settlementAuditId } from '@Contexts/Settlements/Domain/Settlement/SettlementAudit';
import {
  FeePolicyNotOwnerException,
  GroupNotFoundException,
  SettlementNotFoundException,
  SignatureNotValidException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { FeeBearer, settledAmountOf } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/** A cash settlement as the request carries it: the group it is in, the payer's account, and the amount; the payee is the caller. */
export interface RecordCashSettlementInput {
  readonly groupId: string;
  readonly from: string;
  readonly amount: number;
}

/**
 * Records a settlement in cash, decided by its payee (request 12, the storm's `RecordCashSettlement`). The caller is the payee,
 * and must be a member of the group, else the group's `404`. The book of the group is opened as it stands: its version, the members
 * in the order they joined, and the balances the ledger counts, with the payments waiting at the provider counted as paid. The book
 * decides and records it; the store saves the settlement and the book's next version in the transaction, and a second settlement
 * decided at the same moment meets the version check and is decided again on the first one's balances (ADR 10). Answers the new
 * settlement's id.
 */
export const recordCashSettlement = command(
  'RecordCashSettlement',
  (
    store: ISettlementStore,
    members: ISettlementMembers,
    balances: IGroupBalances,
    audit: ISettlementAuditLog,
    clock: Clock,
  ) =>
    async ({ groupId, from, amount }: RecordCashSettlementInput, context): Promise<IResult<string>> => {
      const payeeId = callerOf(context);
      const book = await openBook(store, members, balances, groupId);
      if (!book || !book.hasMember(payeeId)) return Result.fail(new GroupNotFoundException());

      const archived = await members.isArchived(groupId);
      const payeeSuspended = await members.isSuspended(payeeId);
      const recorded = book.recordCash({ from, to: payeeId, amount }, archived, payeeSuspended, clock());
      if (recorded.isFailure()) return Result.fail(recorded.error);

      const settlement = recorded.data;
      await store.save(book, settlement, settlement.at);
      // A cash payment counts from the moment it is recorded, and its payee recorded it (request 28).
      await audit.record({
        id: settlementAuditId.paid(settlement.id),
        groupId,
        at: settlement.at,
        by: payeeId,
        action: 'settlement-paid',
        subjectId: settlement.id,
        amount: settledAmountOf(settlement),
      });
      await publishDomainEvents(book, context);
      return Result.ok(recorded.data.id);
    },
);

/** A payment through the provider as the request carries it: the group it is in, the payee's account, and the amount; the payer is the caller. */
export interface PayThroughProviderInput {
  readonly groupId: string;
  readonly to: string;
  readonly amount: number;
}

/**
 * Asks to pay a member through the payment provider, the caller being the payer (request 13, the storm's `PayThroughProvider`). The
 * caller must be a member of the group, else the group's `404`. The rules are the same as in cash, checked on the book as it stands
 * (the payments waiting at the provider count as paid), and the payee must have a payout account (request 16, read from its
 * repository), before the provider is asked: a refused payment never reaches it. The provider is then asked for the link, with the
 * settlement's id as its reference, the group's currency, and the payee's payout account as the payee; the book decides again
 * with the link in hand and keeps the settlement pending, with the link the payer pays at. The provider's answer is refused, and
 * nothing kept, unless it gives a link. The store's version check holds a second payment decided at the same moment to the rules
 * again, on the first one's balances, and the provider's payment that is then not kept is never counted (its webhook changes
 * nothing). Answers the new settlement's id.
 */
export const payThroughProvider = command(
  'PayThroughProvider',
  (
    store: ISettlementStore,
    members: ISettlementMembers,
    balances: IGroupBalances,
    payouts: IPayoutAccountStore,
    provider: IPaymentProvider,
    clock: Clock,
  ) =>
    async ({ groupId, to, amount }: PayThroughProviderInput, context): Promise<IResult<string>> => {
      const payerId = callerOf(context);
      const book = await openBook(store, members, balances, groupId);
      if (!book || !book.hasMember(payerId)) return Result.fail(new GroupNotFoundException());

      const archived = await members.isArchived(groupId);
      const payerSuspended = await members.isSuspended(payerId);
      // A deleted payee is paid through no provider (feature 35, request 35): refused by name, before the book is asked.
      if (await members.isDeleted(to)) return Result.fail(new AccountDeletedException());
      const proposed = book.proposePayment(
        { from: payerId, to, amount },
        await payouts.payoutAccountOf(to),
        archived,
        payerSuspended,
        clock(),
      );
      if (proposed.isFailure()) return Result.fail(proposed.error);

      const currency = await members.currencyOf(groupId);
      if (!currency) return Result.fail(new GroupNotFoundException());
      const link = await provider.requestPayment({
        reference: proposed.data.id,
        amount,
        currency,
        payee: proposed.data.payee,
      });
      // A payment id the provider already gave another settlement is no link for this one: refused, as any answer Tally cannot keep.
      const reused = link !== undefined && (await store.settlementOfPayment(link.id)) !== undefined;

      const recorded = book.recordPayment(proposed.data, reused ? undefined : link, archived, payerSuspended);
      if (recorded.isFailure()) return Result.fail(recorded.error);

      await store.save(book, recorded.data, recorded.data.at);
      await publishDomainEvents(book, context);
      return Result.ok(recorded.data.id);
    },
);

/** The provider's webhook as the request carries it: the body exactly as it was sent, its signature, and what it says of the payment. */
export interface PaymentWebhookInput {
  readonly body: string;
  readonly signature: string | undefined;
  readonly paymentId: string;
  readonly status: string;
}

/**
 * The provider tells Tally a payment ended (request 13, the storm's `ReceivePaymentWebhook`). Anyone may send it: the signature is the
 * proof, checked over the body as sent before anything is decided, and a missing or wrong one is refused with a `401` and changes
 * nothing. A signed webhook is acknowledged whatever it says: about a payment that succeeded, the settlement is paid and counted by the
 * balances; about one that failed, it is failed and no longer waiting; about one that was refunded, it is refunded and no longer counted
 * (request 15). A payment Tally does not know, a verdict that is still pending,
 * and a payment that already ended change nothing. The book of the settlement's group is saved with the change, at its version
 * (CONC-OPTIMISTIC), so a webhook that arrives twice or out of order is decided once.
 */
export const receivePaymentWebhook = command(
  'ReceivePaymentWebhook',
  (
    store: ISettlementStore,
    members: ISettlementMembers,
    balances: IGroupBalances,
    signatures: IWebhookSignature,
    audit: ISettlementAuditLog,
    clock: Clock,
  ) =>
    async ({ body, signature, paymentId, status }: PaymentWebhookInput, context): Promise<IResult<void>> => {
      if (!signatures.isSignedByProvider(body, signature)) return Result.fail(new SignatureNotValidException());

      const settlement = await store.settlementOfPayment(paymentId);
      if (!settlement) return Result.ok(undefined);
      const book = await openBook(store, members, balances, settlement.groupId);
      if (!book) return Result.ok(undefined);

      const archived = await members.isArchived(settlement.groupId);
      const changed = book.receive(settlement, status, archived);
      if (changed.isFailure()) return Result.fail(changed.error);
      if (!changed.data) return Result.ok(undefined);

      // The status is learned now: its history line is the time Tally was told (request 19).
      const learnedAt = clock().toISOString();
      const learned = changed.data;
      await store.save(book, learned, learnedAt);
      // The balances start to count a payment the provider says succeeded, for the payer who made it, and stop counting a refunded one,
      // for the payee who refunded it (request 28). A failed payment changes no money, so it has no entry.
      if (learned.status === 'paid') {
        await audit.record({
          id: settlementAuditId.paid(learned.id),
          groupId: learned.groupId,
          at: learnedAt,
          by: learned.from,
          action: 'settlement-paid',
          subjectId: learned.id,
          amount: settledAmountOf(learned),
        });
      }
      if (learned.status === 'refunded') {
        await audit.record({
          id: settlementAuditId.refunded(learned.id),
          groupId: learned.groupId,
          at: learnedAt,
          by: learned.to,
          action: 'settlement-refunded',
          subjectId: learned.id,
          amount: settledAmountOf(learned),
        });
      }
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
  { caller: 'anyone' },
);

/**
 * The payee of a settlement paid through the provider refunds it, whole (request 15, the storm's `RefundSettlement`). The caller must be a
 * member of the settlement's group, else the settlement's `404`; the payee only (`403` to any other member); the settlement must be a
 * payment through the provider that is `paid` (`422`); and its payer and payee must still be members of the group (`422`). The book of the
 * group is opened as it stands, and the provider is asked for the refund with the payment's id and the settlement's id as the reference,
 * only once those rules hold. A provider that does not accept the refund refuses it (`422`) and nothing changes. Otherwise the settlement is
 * `refunding`: still counted as paid until the provider's webhook says it is refunded. Answers nothing (`204`).
 */
export const refundSettlement = command(
  'RefundSettlement',
  (
    store: ISettlementStore,
    members: ISettlementMembers,
    balances: IGroupBalances,
    provider: IPaymentProvider,
    clock: Clock,
  ) =>
    async (settlementId: string, context): Promise<IResult<void>> => {
      const payeeId = callerOf(context);
      const settlement = await store.settlementOf(settlementId);
      if (!settlement) return Result.fail(new SettlementNotFoundException());
      const book = await openBook(store, members, balances, settlement.groupId);
      if (!book || !book.hasMember(payeeId)) return Result.fail(new SettlementNotFoundException());

      const archived = await members.isArchived(settlement.groupId);
      const proposed = book.proposeRefund(settlement, payeeId, archived);
      if (proposed.isFailure()) return Result.fail(proposed.error);
      const accepted = await provider.refundPayment({ paymentId: proposed.data.id, reference: settlement.id });

      const recorded = book.recordRefund(settlement, accepted, archived);
      if (recorded.isFailure()) return Result.fail(recorded.error);

      await store.save(book, recorded.data, clock().toISOString());
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
);

/** Who bears a group's provider fee, as the request carries it: the owner's choice, by its name (request 38). */
export interface SetFeePolicyInput {
  readonly groupId: string;
  readonly borneBy: string;
}

/**
 * The owner of a group decides who bears its provider fee from now on (request 38, the storm's `SetFeePolicy`): `payer`, `payee` or
 * `shared`. The caller must be a member of the group, else the group's `404`; the owner only (`403` to any other member); a bearer that is
 * none of the three is refused (`422`) and an archived group changes nothing. The book is opened as it stands and stored at its next
 * version with the policy, so a payment asked for after it is fixed with it, and one asked for before keeps the policy it was asked with.
 * Answers nothing (`204`).
 */
export const setFeePolicy = command(
  'SetFeePolicy',
  (store: ISettlementStore, members: ISettlementMembers, balances: IGroupBalances, clock: Clock) =>
    async ({ groupId, borneBy }: SetFeePolicyInput, context): Promise<IResult<void>> => {
      const callerId = callerOf(context);
      const book = await openBook(store, members, balances, groupId);
      if (!book || !book.hasMember(callerId)) return Result.fail(new GroupNotFoundException());
      if ((await members.ownerOf(groupId)) !== callerId) return Result.fail(new FeePolicyNotOwnerException());

      const archived = await members.isArchived(groupId);
      const decided = book.setFeePolicy(borneBy, archived, clock());
      if (decided.isFailure()) return Result.fail(decided.error);

      await store.saveBook(book);
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
);

/**
 * Who bears a group's provider fee, as a member of the group reads it (request 38, the storm's `GetFeePolicy`): `payer`, `payee` or
 * `shared`, the payee until the owner decides. To anyone else the group does not exist: the group's `404`.
 */
export const getFeePolicy = query(
  'GetFeePolicy',
  (store: ISettlementStore, members: ISettlementMembers) =>
    async (groupId: string, context): Promise<IResult<{ borneBy: FeeBearer }>> => {
      const memberIds = await members.membersOf(groupId);
      if (!memberIds || !memberIds.includes(callerOf(context))) return Result.fail(new GroupNotFoundException());
      return Result.ok({ borneBy: await store.feePolicyOf(groupId) });
    },
);

/**
 * The settlements of a group, as a member of it reads them (request 19, the storm's `GetGroupSettlements`): each as `GetSettlement`
 * reads it, with its history, the most recently decided first. The members are the group's current members (a settlement stays the
 * group's after its payer or payee leaves). To anyone else the group does not exist: the group's `404`.
 */
export const getGroupSettlements = query(
  'GetGroupSettlements',
  (store: ISettlementStore, members: ISettlementMembers) =>
    async (groupId: string, context): Promise<IResult<SettlementView[]>> => {
      const memberIds = await members.membersOf(groupId);
      if (!memberIds || !memberIds.includes(callerOf(context))) return Result.fail(new GroupNotFoundException());
      return Result.ok(await store.viewsOfGroup(groupId));
    },
);

/**
 * A settlement as a member of its group reads it: its group, payer, payee, amount, how it was paid, its status, when it was
 * decided, and every status it has had, the earliest first (request 19), and (through the provider) the link the payer pays at. To
 * anyone else it does not exist: the same `404` for a settlement that does not exist and one of a group the caller is not in.
 */
export const getSettlement = query(
  'GetSettlement',
  (store: ISettlementStore, members: ISettlementMembers) =>
    async (settlementId: string, context): Promise<IResult<SettlementView>> => {
      const view = await store.viewOf(settlementId);
      if (!view) return Result.fail(new SettlementNotFoundException());

      const memberIds = await members.membersOf(view.groupId);
      if (!memberIds || !memberIds.includes(callerOf(context))) return Result.fail(new SettlementNotFoundException());
      return Result.ok(view);
    },
);
