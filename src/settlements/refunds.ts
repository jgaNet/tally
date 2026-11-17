import { type Database, inTransaction } from '../database';
import { leftMembersAmong } from '../groups/groups';
import { Refusal } from '../refusal';
import type { ProviderConfig } from './provider';
import { recordStatus } from './history';
import { requireSettlement } from './settlements';

/**
 * Asks the provider to refund the settlement `settlementId`, whole, and answers nothing. Only its payee may:
 * `accountId` is refused with `403` when it is a member of the group who is not the payee, and with `404` when
 * it is not a member at all, as for a settlement that does not exist. Only a settlement paid through the
 * provider, and still `paid`, can be refunded, so a cash one, a pending one, and one already refunding or
 * refunded are refused with `409`. So is one of whose members has left the group: its balances must still add
 * up to 0. Nothing is changed by a refusal.
 *
 * The settlement is held as `refunding` in a transaction, so a second request sees it and is refused, and the
 * balances go on counting it as paid. The provider is then asked outside the transaction, with the settlement's
 * id as the reference. When it does not answer `201 { id }` in time, the hold is released, the settlement is
 * `paid` again, and the request is refused. A refund the provider reports as done arrives by webhook.
 */
export async function requestRefund(
  db: Database,
  provider: ProviderConfig,
  settlementId: string,
  accountId: string,
): Promise<void> {
  const held = inTransaction(db, () => {
    const settlement = requireSettlement(db, settlementId, accountId);
    if (settlement.to !== accountId) {
      throw new Refusal(403, 'NotPayee', 'Only the member who was paid can refund a settlement.');
    }
    if (settlement.method !== 'provider' || settlement.status !== 'paid') {
      throw new Refusal(
        409,
        'NotRefundable',
        'Only a payment through the provider that is paid, and not refunded yet, can be refunded.',
      );
    }
    if (leftMembersAmong(db, settlement.groupId, [settlement.from, settlement.to]).length > 0) {
      throw new Refusal(
        409,
        'MemberHasLeft',
        'A member of this settlement has left the group, so it cannot be refunded: the balances must add up to 0.',
      );
    }
    if (provider.url === '') {
      throw new Refusal(409, 'ProviderNotConfigured', 'Payment through the provider is not set up on this server.');
    }
    const row = db.prepare('SELECT provider_payment_id FROM settlements WHERE id = ?').get(settlementId) as
      { provider_payment_id: string | null } | undefined;
    const paymentId = row?.provider_payment_id;
    if (!paymentId) {
      throw new Refusal(409, 'NotRefundable', 'This payment has no provider payment to refund.');
    }
    db.prepare(`UPDATE settlements SET status = 'refunding' WHERE id = ? AND status = 'paid'`).run(settlementId);
    recordStatus(db, settlementId, 'refunding');
    return { paymentId };
  });

  try {
    await createProviderRefund(provider, held.paymentId, settlementId);
  } catch {
    // Released only while it is still held: a refund the provider has reported in the meantime stands.
    inTransaction(db, () => {
      const released = db
        .prepare(`UPDATE settlements SET status = 'paid' WHERE id = ? AND status = 'refunding'`)
        .run(settlementId);
      if (released.changes > 0) {
        recordStatus(db, settlementId, 'paid');
      }
    });
    throw new Refusal(
      409,
      'RefundNotStarted',
      'The payment provider did not refund the payment: nothing changed. Try again.',
    );
  }
}

/**
 * `POST {url}/payments/{paymentId}/refunds` with the settlement's id as the `reference`. Anything but `201`
 * with an `id` is an error.
 */
async function createProviderRefund(provider: ProviderConfig, paymentId: string, reference: string): Promise<void> {
  const response = await fetch(`${provider.url}/payments/${encodeURIComponent(paymentId)}/refunds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reference }),
    // Covers the whole exchange, the answer's body included.
    signal: AbortSignal.timeout(provider.timeoutMs),
  });
  if (response.status !== 201) {
    throw new Error(`the provider answered ${response.status}`);
  }
  const answer = (await response.json()) as { id?: unknown } | null;
  if (typeof answer !== 'object' || answer === null || typeof answer.id !== 'string' || answer.id === '') {
    throw new Error('the provider did not answer with an id');
  }
}
