import { callerOf, command } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';

import { ISettlementBooks } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBooks';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Suggestion/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Suggestion/Ports/ISettlementMembers';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { IWebhookSignature } from '@Contexts/Settlements/Application/Ports/IWebhookSignature';

/** What a member gives to pay through the provider: the group, the payee (`to`, an account id) and the amount (request 13). */
export interface PayThroughProviderInput {
  groupId: string;
  to: string;
  amount: number;
}

/**
 * Asks the provider for a payment link and keeps the settlement pending, the caller its payer (request 13, docs/adr/0014). The rules are
 * the book's, as for a cash settlement, and the book decides before the provider is asked and again with the link in hand: a refused
 * settlement asks the provider for nothing, and a provider that gives no link keeps nothing. The settlement's id is the reference the
 * provider is given, so its webhook names the settlement it is about. Two requests at once meet the book's version as in cash
 * (CONC-OPTIMISTIC): the one that loses re-reads, and a payment its provider has already made for it is never paid, as nothing
 * names it. Its id is the answer.
 */
export const payThroughProvider = command(
  'PayThroughProvider',
  (
    books: ISettlementBooks,
    balances: IGroupBalances,
    members: ISettlementMembers,
    provider: IPaymentProvider,
    clock: Clock,
  ) =>
    async ({ groupId, to, amount }: PayThroughProviderInput, context) => {
      const by = callerOf(context);
      const group = await members.groupOf(by, groupId);
      if (!group) return Result.fail(new NotFoundException('Settlements', 'There is no such group'));

      const book = await books.get(groupId);
      const owed = await balances.balancesOf(groupId);
      const balanceOf = (memberId: string) => owed.find(balance => balance.memberId === memberId)?.balance ?? 0;

      const request = {
        by,
        to,
        amount,
        members: group.members.map(member => member.memberId),
        balances: { payer: balanceOf(by), payee: balanceOf(to) },
        at: clock(),
      };
      const reserved = book.reserveProviderPayment(request);
      if (reserved.isFailure()) return reserved;

      const link = await provider.requestPayment({ reference: reserved.data, amount, currency: group.currency });
      if (link.isFailure()) return link;

      const recorded = book.recordProviderPayment(request, {
        settlementId: reserved.data,
        providerPaymentId: link.data.id,
        payUrl: link.data.payUrl,
      });
      if (recorded.isFailure()) return recorded;

      const saved = await books.save(book);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(book, context);
      return Result.ok(recorded.data.id);
    },
);

/** What a payee gives to refund a settlement paid through the provider: the settlement's id (request 15). */
export interface RefundSettlementInput {
  id: string;
}

/**
 * Asks the provider to refund a settlement paid through it, whole, for its payee (request 15, docs/adr/0015). The settlement's book is read
 * first: a settlement that is not in a group the caller is a member of does not exist for it (`404`). The book decides which settlements may be
 * refunded: a paid one through the provider, asked by its payee, whose payer and payee are still members (anything else is refused, `403`
 * for another member or `422`, and nothing changes). The provider is asked next, and the settlement is `refunding` once it accepted: the
 * balances still count it until the provider's webhook says it is refunded. A provider that does not accept refuses the refund, and nothing
 * changes. Answers `204`: there is nothing to say back.
 */
export const refundSettlement = command(
  'RefundSettlement',
  (books: ISettlementBooks, members: ISettlementMembers, provider: IPaymentProvider) =>
    async ({ id }: RefundSettlementInput, context) => {
      const by = callerOf(context);
      const book = await books.ofSettlement(id);
      if (!book) return Result.fail(new NotFoundException('Settlements', 'There is no such settlement'));
      const group = await members.groupOf(by, book.groupId);
      if (!group) return Result.fail(new NotFoundException('Settlements', 'There is no such settlement'));

      const request = { by, settlementId: id, members: group.members.map(member => member.memberId) };
      const reserved = book.reserveRefund(request);
      if (reserved.isFailure()) return reserved;

      const asked = await provider.refundPayment({ paymentId: reserved.data.providerPaymentId, reference: id });
      if (asked.isFailure()) return asked;

      const recorded = book.recordRefund(request);
      if (recorded.isFailure()) return recorded;
      const saved = await books.save(book);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
);

/** What the provider's webhook says: the body as it was sent (signed), the signature it carries, and the payment and its status. */
export interface ReceivePaymentWebhookInput {
  body: string;
  signature?: string;
  paymentId: string;
  status: string;
}

/**
 * The provider's webhook: a signed word that a payment ended (request 13, docs/adr/0014). Anyone may send it: the signature is the proof,
 * checked over the body as sent before anything is decided, and a missing or wrong one is refused with `401`. A webhook about a payment
 * Tally does not know changes nothing, and so does a status that is not an end, or one for a payment that is not pending any more: the
 * provider is acknowledged whatever it says. A payment that succeeded makes its settlement paid, and one that failed makes it failed; one that
 * was refunded makes its settlement refunded, once (request 15).
 */
export const receivePaymentWebhook = command(
  'ReceivePaymentWebhook',
  (books: ISettlementBooks, signatures: IWebhookSignature) =>
    async ({ body, signature, paymentId, status }: ReceivePaymentWebhookInput, context) => {
      if (!signatures.isSignedBy(body, signature)) {
        return Result.fail(new NotAllowedException('Settlements', 'The webhook is not signed by the payment provider'));
      }

      const book = await books.ofPayment(paymentId);
      if (!book) return Result.ok(undefined);
      book.settleProviderPayment({ providerPaymentId: paymentId, status });
      if (book.moved.length === 0) return Result.ok(undefined);

      const saved = await books.save(book);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
  { caller: 'anyone' },
);
