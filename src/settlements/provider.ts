import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeleted } from '../accounts/accounts';
import { recordAudit } from '../audit/audit';
import { type Database, inTransaction } from '../database';
import { requireNotSuspended } from '../admin/suspensions';
import { requireMembership, requireNotArchived } from '../groups/groups';
import { type Currency, minorUnitDigitsOf } from '../groups/validation';
import { payoutAccountOf } from '../payouts/payout-accounts';
import { type RatesConfig, convertedAmount } from '../rates/rates';
import { Refusal } from '../refusal';
import { type StatusEntry, recordStatus } from './history';
import { feePolicyOf } from './fees';
import { type PricedSettlement, type SettlementMoneyInput, paidOf, priceSettlement } from './money';
import { checkNewSettlement, originalColumns } from './settlements';

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
 * Asks the provider for a payment, `money` (in the group's currency, or in another at the rate offered today) from
 * `payerId` to `payeeId` in `groupId`, and answers the settlement's id. The payment is asked for in the currency and the
 * amount it is paid in: the original when the settlement has one, else the group's. The settlement is kept `pending`
 * with the provider's `payUrl`, and with the fee the provider says, converted to the group's currency at the settlement's
 * rate, which is kept out of what it settles: who bears it is the group's policy as it is now, kept with it.
 *
 * The rules are those of a cash settlement, with a payment waiting at the provider counting as paid. A payee whose
 * account is deleted is refused with `AccountDeleted`. The payee must have a payout account, which the provider is
 * told: a payee with none is refused before the provider is asked. The rate is asked before the settlement is held, and
 * a settlement refused for a rule asks nothing of the rates service. The settlement is first held in a transaction, so
 * a second request sees it; the provider is then asked outside the transaction. When the provider does not answer
 * `201 { id, payUrl, fee }` in time, or its fee is not a whole number from 0 below the amount paid, or below the group's
 * amount once converted, the hold is removed and the request is refused: nothing is kept.
 */
export async function requestProviderSettlement(
  db: Database,
  provider: ProviderConfig,
  rates: RatesConfig,
  groupId: string,
  payerId: string,
  payeeId: string,
  money: SettlementMoneyInput,
): Promise<string> {
  const group = await requireMembership(db, groupId, payerId);
  await requireNotSuspended(db, payerId);
  await requireNotArchived(db, groupId);
  if (provider.url === '') {
    throw new Refusal(409, 'ProviderNotConfigured', 'Payment through the provider is not set up on this server.');
  }
  if (await isDeleted(db, payeeId)) {
    throw new Refusal(
      409,
      'AccountDeleted',
      'The payee has deleted their account: nothing is paid to it through the provider.',
    );
  }
  const priced = await priceSettlement(rates, group.currency, money);
  const held = await inTransaction(db, async () => {
    await requireMembership(db, groupId, payerId);
    await requireNotSuspended(db, payerId);
    await requireNotArchived(db, groupId);
    if (await isDeleted(db, payeeId)) {
      throw new Refusal(
        409,
        'AccountDeleted',
        'The payee has deleted their account: nothing is paid to it through the provider.',
      );
    }
    await checkNewSettlement(db, groupId, payerId, payeeId, priced.amount);
    const borneBy = await feePolicyOf(db, groupId);
    // The payee's account as it is now: a payment asked for goes to the account set at that moment.
    const payee = await payoutAccountOf(db, payeeId);
    if (payee === undefined) {
      throw new Refusal(
        409,
        'NoPayoutAccount',
        'The payee has no payout account at the payment provider: they must set one before they are paid through it.',
      );
    }
    const id = randomUUID();
    const at = new Date().toISOString();
    await db.execute(
      `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at,
                                original_currency, original_amount, original_rate)
       VALUES (?, ?, ?, ?, ?, 'provider', 'pending', ?, ?, ?, ?)`,
      [id, groupId, payerId, payeeId, priced.amount, at, ...originalColumns(priced.original)],
    );
    await recordStatus(db, id, 'pending', at);
    return { id, payee, borneBy };
  });

  const paid = paidOf(priced, group.currency);
  let payment: ProviderPayment;
  try {
    payment = await createProviderPayment(
      provider,
      { reference: held.id, amount: paid.amount, currency: paid.currency, payee: held.payee },
      priced,
      group.currency,
    );
  } catch {
    await db.execute('DELETE FROM settlements WHERE id = ?', [held.id]);
    throw new Refusal(
      409,
      'PaymentNotStarted',
      'The payment provider did not start a payment: nothing was kept. Try again.',
    );
  }

  // The fee and who bears it are kept together with the payment, as they were when it was asked for.
  await db.execute(
    'UPDATE settlements SET pay_url = ?, provider_payment_id = ?, fee_amount = ?, fee_borne_by = ? WHERE id = ?',
    [payment.payUrl, payment.id, payment.fee, held.borneBy, held.id],
  );
  return held.id;
}

interface ProviderPayment {
  /** The provider's id for the payment: what its webhooks name. */
  id: string;
  /** Where the payer pays. */
  payUrl: string;
  /** The provider's fee, in the minor unit of the group's currency, converted at the settlement's rate: a whole number from 0, below the group's amount. */
  fee: number;
}

/**
 * `POST {url}/payments`. Anything but `201` with an `id`, a `payUrl` and a `fee` is an error. The fee is in the minor unit
 * of the currency the payment is made in: it must be a whole number from 0 below the amount paid, and, converted to the
 * group's currency at the settlement's rate, below the group's amount, else a payment whose fee is not known is not started.
 */
async function createProviderPayment(
  provider: ProviderConfig,
  body: { reference: string; amount: number; currency: Currency; payee: string },
  priced: PricedSettlement,
  groupCurrency: Currency,
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
  const answer = (await response.json()) as Partial<Record<'id' | 'payUrl' | 'fee', unknown>> | null;
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
  if (typeof answer.fee !== 'number' || !Number.isInteger(answer.fee) || answer.fee < 0 || answer.fee >= body.amount) {
    throw new Error('the provider did not answer with a fee below the amount');
  }
  const fee = convertedAmount(
    answer.fee,
    priced.millionths,
    minorUnitDigitsOf(body.currency),
    minorUnitDigitsOf(groupCurrency),
  );
  if (fee >= BigInt(priced.amount)) {
    throw new Error('the provider did not answer with a fee below the amount, in the group’s currency');
  }
  return { id: answer.id, payUrl: answer.payUrl, fee: Number(fee) };
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
export async function applyProviderStatus(db: Database, paymentId: string, status: string): Promise<void> {
  switch (status) {
    case 'succeeded':
      return setProviderStatus(db, paymentId, 'paid', ['pending']);
    case 'failed':
      return setProviderStatus(db, paymentId, 'failed', ['pending']);
    case 'refunded':
      return setProviderStatus(db, paymentId, 'refunded', ['pending', 'paid', 'refunding']);
    default:
      // `pending`, or a word Tally does not know: nothing is changed.
      return;
  }
}

interface ProviderSettlementRow {
  id: string;
  group_id: string;
  /** The status it had before the provider's word. */
  status: StatusEntry['status'];
  payer_id: string;
  payee_id: string;
  /** What it settles: the amount, less the part of the fee its payer bears. */
  settled_amount: number;
}

/**
 * The change of money a provider's word makes to a settlement, if any: it starts to count when it becomes `paid`,
 * made by its payer; it stops counting when it becomes `refunded` from a status that counted (`paid` or
 * `refunding`), made by its payee. A payment that never counted, one refunded while still pending, moves no money.
 */
function moneyChangeOf(
  settlement: ProviderSettlementRow,
  status: StatusEntry['status'],
): { by: string; action: 'settlement-paid' | 'settlement-refunded' } | undefined {
  if (status === 'paid') {
    return { by: settlement.payer_id, action: 'settlement-paid' };
  }
  if (status === 'refunded' && (settlement.status === 'paid' || settlement.status === 'refunding')) {
    return { by: settlement.payee_id, action: 'settlement-refunded' };
  }
  return undefined;
}

/**
 * Sets the provider settlement of `paymentId` to `status`, if it is now one of `from`, and records the
 * change in its history. A word that changes nothing records nothing.
 */
async function setProviderStatus(
  db: Database,
  paymentId: string,
  status: StatusEntry['status'],
  from: readonly StatusEntry['status'][],
): Promise<void> {
  await inTransaction(db, async () => {
    // `from` is written here, never from a request: only its placeholders are built from it.
    const settlements = await db.rows<ProviderSettlementRow>(
      `SELECT settlements.id, settlements.group_id, settlements.status, settlements.payer_id, settlements.payee_id,
              settlements.settled_amount
         FROM settlements
        WHERE settlements.provider_payment_id = ? AND settlements.method = 'provider'
          AND settlements.status IN (${from.map(() => '?').join(', ')})`,
      [paymentId, ...from],
    );
    for (const settlement of settlements) {
      // An archived group is read only: the provider's word cannot change its settlement, so it is refused.
      await requireNotArchived(db, settlement.group_id);
      const at = new Date().toISOString();
      await db.execute('UPDATE settlements SET status = ? WHERE id = ?', [status, settlement.id]);
      await recordStatus(db, settlement.id, status, at);
      const change = moneyChangeOf(settlement, status);
      if (change !== undefined) {
        await recordAudit(
          db,
          settlement.group_id,
          { ...change, subjectId: settlement.id, amount: settlement.settled_amount },
          at,
        );
      }
    }
  });
}
