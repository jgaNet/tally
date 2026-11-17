import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { type Database, inTransaction } from '../database';
import { requireMembership } from '../groups/groups';
import { payoutAccountOf } from '../payouts/payout-accounts';
import { Refusal } from '../refusal';
import { type StatusEntry, recordStatus } from './history';
import { checkNewSettlement } from './settlements';

/** Where the payment provider is, and the secret it and Tally share. */
export interface ProviderConfig {
  /** The base of the provider's API, without a trailing slash. Empty when there is no provider. */
  url: string;
  /** The secret the provider signs its webhooks with. Empty when there is none: no webhook is then trusted. */
  webhookSecret: string;
  /** How long the provider may take to answer a payment, in milliseconds. */
  timeoutMs: number;
}

/**
 * Asks the provider for a payment of `amount` in `groupId`'s currency, `payerId` paying `payeeId`, and
 * answers the settlement's id. The settlement is kept `pending` with the provider's `payUrl`.
 *
 * The rules are those of a cash settlement, with a payment waiting at the provider counting as paid. The
 * payee must have a payout account, which the provider is told: a payee with none is refused before the
 * provider is asked. The settlement is first held in a transaction, so a second request sees it; the
 * provider is then asked outside the transaction. When the provider does not answer `201 { id, payUrl }`
 * in time, the hold is removed and the request is refused: nothing is kept.
 */
export async function requestProviderSettlement(
  db: Database,
  provider: ProviderConfig,
  groupId: string,
  payerId: string,
  payeeId: string,
  amount: number,
): Promise<string> {
  const held = inTransaction(db, () => {
    const group = requireMembership(db, groupId, payerId);
    if (provider.url === '') {
      throw new Refusal(409, 'ProviderNotConfigured', 'Payment through the provider is not set up on this server.');
    }
    checkNewSettlement(db, groupId, payerId, payeeId, amount);
    // The payee's account as it is now: a payment asked for goes to the account set at that moment.
    const payee = payoutAccountOf(db, payeeId);
    if (payee === undefined) {
      throw new Refusal(
        409,
        'NoPayoutAccount',
        'The payee has no payout account at the payment provider: they must set one before they are paid through it.',
      );
    }
    const id = randomUUID();
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'provider', 'pending', ?)`,
    ).run(id, groupId, payerId, payeeId, amount, at);
    recordStatus(db, id, 'pending', at);
    return { id, currency: group.currency, payee };
  });

  let payment: ProviderPayment;
  try {
    payment = await createProviderPayment(provider, {
      reference: held.id,
      amount,
      currency: held.currency,
      payee: held.payee,
    });
  } catch {
    db.prepare('DELETE FROM settlements WHERE id = ?').run(held.id);
    throw new Refusal(
      409,
      'PaymentNotStarted',
      'The payment provider did not start a payment: nothing was kept. Try again.',
    );
  }

  db.prepare('UPDATE settlements SET pay_url = ?, provider_payment_id = ? WHERE id = ?').run(
    payment.payUrl,
    payment.id,
    held.id,
  );
  return held.id;
}

interface ProviderPayment {
  /** The provider's id for the payment: what its webhooks name. */
  id: string;
  /** Where the payer pays. */
  payUrl: string;
}

/** `POST {url}/payments`. Anything but `201` with an `id` and a `payUrl` is an error. */
async function createProviderPayment(
  provider: ProviderConfig,
  body: { reference: string; amount: number; currency: string; payee: string },
): Promise<ProviderPayment> {
  const response = await fetch(`${provider.url}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // Covers the whole exchange, the answer's body included.
    signal: AbortSignal.timeout(provider.timeoutMs),
  });
  if (response.status !== 201) {
    throw new Error(`the provider answered ${response.status}`);
  }
  const answer = (await response.json()) as Partial<Record<keyof ProviderPayment, unknown>> | null;
  if (
    typeof answer !== 'object' ||
    answer === null ||
    typeof answer.id !== 'string' ||
    answer.id === '' ||
    typeof answer.payUrl !== 'string' ||
    answer.payUrl === ''
  ) {
    throw new Error('the provider did not answer with an id and a payUrl');
  }
  return { id: answer.id, payUrl: answer.payUrl };
}

/**
 * Whether `signature` is the HMAC-SHA256 of `body`, the bytes as the provider sent them, with `secret`
 * as the key, in lowercase hexadecimal. Without a secret nothing is signed correctly, so nothing passes.
 */
export function signatureIsValid(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (secret === '' || signature === undefined) {
    return false;
  }
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Applies the provider's word about payment `paymentId`. `succeeded` pays a pending settlement, `failed`
 * fails one, and `refunded` refunds one that is pending, paid or being refunded: a refund may overtake the
 * success of the same payment, and then the settlement is refunded and never counted. Each word only
 * changes a payment that has not reached it, so a redelivered or late webhook changes nothing: a payment
 * that has ended stays as it ended. `pending`, and a payment Tally does not know, change nothing.
 */
export function applyProviderStatus(db: Database, paymentId: string, status: string): void {
  switch (status) {
    case 'succeeded':
      setProviderStatus(db, paymentId, 'paid', ['pending']);
      return;
    case 'failed':
      setProviderStatus(db, paymentId, 'failed', ['pending']);
      return;
    case 'refunded':
      setProviderStatus(db, paymentId, 'refunded', ['pending', 'paid', 'refunding']);
      return;
    default:
      // `pending`, or a word Tally does not know: nothing is changed.
      return;
  }
}

/**
 * Sets the provider settlement of `paymentId` to `status`, if it is now one of `from`, and records the
 * change in its history. A word that changes nothing records nothing.
 */
function setProviderStatus(
  db: Database,
  paymentId: string,
  status: StatusEntry['status'],
  from: readonly StatusEntry['status'][],
): void {
  inTransaction(db, () => {
    // `from` is written here, never from a request: only its placeholders are built from it.
    const settlements = db
      .prepare(
        `SELECT id FROM settlements
          WHERE provider_payment_id = ? AND method = 'provider' AND status IN (${from.map(() => '?').join(', ')})`,
      )
      .all(paymentId, ...from) as { id: string }[];
    for (const { id } of settlements) {
      db.prepare('UPDATE settlements SET status = ? WHERE id = ?').run(status, id);
      recordStatus(db, id, status);
    }
  });
}
