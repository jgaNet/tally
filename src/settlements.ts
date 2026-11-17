import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type Balance, balancesOfGroup } from './balances';
import { findGroupOfMember, membersOfGroup } from './groups';
import { type ProviderConfig, requestPayment, requestRefund } from './provider';
import { payoutAccountOf } from './payout-accounts';
import { Refusal } from './refusal';
import { inReadSnapshot, inTransaction } from './transactions';

/** One transfer of a suggested settlement: `from` pays `to` the `amount`. The ids are the members' account ids. */
export interface Transfer {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

/**
 * The transfers that bring every balance to 0, by this algorithm, so that every member reads the same ones:
 *
 * 1. Start from the balances, in the order the members joined (as {@link balancesOfGroup} gives them).
 * 2. Take the member who owes the most (the lowest balance) and the member who is owed the most (the highest
 *    balance). On a tie, the member who joined first, being first in the order given.
 * 3. The first pays the second the smaller of what the first owes and what the second is owed. That is one
 *    transfer; both balances move by its amount, and whoever is now at 0 is even.
 * 4. Repeat from 2 until every balance is 0.
 *
 * Each transfer zeroes at least one balance, so there are never more transfers than members whose balance is
 * not 0, less one. With every balance already 0 there is none. The input is not changed.
 */
export function suggestTransfers(balances: readonly Balance[]): Transfer[] {
  const remaining = balances.map(balance => ({ memberId: balance.memberId, balance: Number(balance.balance) }));
  const transfers: Transfer[] = [];
  for (;;) {
    let debtor = -1;
    let creditor = -1;
    remaining.forEach((member, index) => {
      // Strict comparisons keep the earliest index on a tie: the member who joined first.
      if (member.balance < 0 && (debtor < 0 || member.balance < remaining[debtor].balance)) debtor = index;
      if (member.balance > 0 && (creditor < 0 || member.balance > remaining[creditor].balance)) creditor = index;
    });
    if (debtor < 0 || creditor < 0) return transfers;
    const amount = Math.min(-remaining[debtor].balance, remaining[creditor].balance);
    transfers.push({ from: remaining[debtor].memberId, to: remaining[creditor].memberId, amount });
    remaining[debtor].balance += amount;
    remaining[creditor].balance -= amount;
  }
}

/**
 * The suggested settlement of a group, read by `readerId`, who must be a current member of the group (else
 * `404`, as if the group did not exist). It reads one consistent state of the file and changes nothing: a
 * suggestion records nothing, and the balances stay what the expenses and the paid settlements make them.
 * A settlement waiting at the payment provider counts as paid here, so the suggestion leaves it out.
 */
export function suggestedSettlement(db: DatabaseSync, readerId: string, groupId: string): Transfer[] {
  return inReadSnapshot(db, () => {
    if (!findGroupOfMember(db, readerId, groupId)) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    return suggestTransfers(balancesOfGroup(db, groupId, { includePending: true }));
  });
}

/** What the application knows of a settlement, as a member of its group sees it. `at` is when it was recorded. */
export interface Settlement {
  readonly id: string;
  readonly groupId: string;
  /** The member who paid the amount: in cash to the payee, or through the provider. */
  readonly from: string;
  /** The member who was paid: the one who recorded a cash settlement, or the one the provider payment is to. */
  readonly to: string;
  readonly amount: number;
  readonly method: 'cash' | 'provider';
  /**
   * `pending` while the provider has not ended the payment; `failed` when it failed, and it never counts. A `paid`
   * one is `refunding` once its refund is asked of the provider, and `refunded` once the provider says so.
   */
  readonly status: 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';
  readonly at: string;
  /** The link where the payer pays, through the provider; a settlement in cash has none. */
  readonly payUrl?: string;
}

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: 'cash' | 'provider';
  status: Settlement['status'];
  provider_payment_id: string | null;
  pay_url: string | null;
  created_at: string;
}

const SETTLEMENT_COLUMNS =
  's.id, s.group_id, s.payer_id, s.payee_id, s.amount, s.method, s.status, s.pay_url, s.created_at';

function settlementOf(row: SettlementRow): Settlement {
  const settlement = {
    id: row.id,
    groupId: row.group_id,
    from: row.payer_id,
    to: row.payee_id,
    amount: Number(row.amount),
    method: row.method,
    status: row.status,
    at: row.created_at,
  };
  return row.pay_url === null ? settlement : { ...settlement, payUrl: row.pay_url };
}

/**
 * The rules a settlement of `amount` from `payerId` to `payeeId` in the group must meet, checked on the balances
 * as they stand, with a settlement waiting at the provider counted as paid: a whole number from 1; the payer is
 * not the payee; the payer is a member of the group; and the amount is not more than the payer still owes, nor
 * more than the payee is still owed. Refused with `422` or `409` otherwise.
 */
function checkSettlement(
  db: DatabaseSync,
  input: { groupId: string; payerId: string; payeeId: string; amount: number },
): void {
  const { groupId, payerId, payeeId, amount } = input;
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Refusal(422, 'AmountIsInvalid', 'The amount must be a whole number, at least 1.');
  }
  if (payerId === payeeId) {
    throw new Refusal(422, 'PayerIsPayee', 'The member who paid cannot be the member who was paid.');
  }
  if (!membersOfGroup(db, groupId).some(member => member.memberId === payerId)) {
    throw new Refusal(422, 'PayerNotInGroup', 'The payer must be a member of the group.');
  }
  const balances = balancesOfGroup(db, groupId, { includePending: true });
  const payerBalance = balances.find(member => member.memberId === payerId)?.balance ?? 0;
  const payeeBalance = balances.find(member => member.memberId === payeeId)?.balance ?? 0;
  const owedByPayer = Math.max(0, -payerBalance);
  const owedToPayee = Math.max(0, payeeBalance);
  if (amount > owedByPayer || amount > owedToPayee) {
    throw new Refusal(
      409,
      'AmountExceedsBalance',
      'The amount must not be more than the payer owes, nor more than the payee is owed.',
    );
  }
}

/**
 * Records that `payerId` paid `payeeId` the `amount` in cash, in the group, and answers its id. The payee
 * is the member who records it. Refused with `404` when the payee is not a member of the group; with `422`
 * when the amount is not a whole number from 1, when the payer is the payee, or when the payer is not a
 * member of the group; with `409` when the amount is more than the payer owes (the opposite of their
 * balance) or more than the payee is owed (their balance), on the balances as they stand, a settlement
 * waiting at the provider counted as paid. The balances are read and the settlement written in one
 * transaction, so two settlements recorded at once are each decided on the balances the other left: when
 * both would pay more than is owed, one is refused.
 */
export function recordCashSettlement(
  db: DatabaseSync,
  input: { groupId: string; payeeId: string; payerId: string; amount: number },
): string {
  const { groupId, payeeId, payerId, amount } = input;
  const id = randomUUID();
  inTransaction(db, () => {
    if (!findGroupOfMember(db, payeeId, groupId)) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    checkSettlement(db, { groupId, payerId, payeeId, amount });
    db.prepare(
      'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, groupId, payerId, payeeId, amount, 'cash', 'paid', new Date().toISOString());
  });
  return id;
}

/**
 * Asks the payment provider for a payment of `amount` from `payerId` (the caller) to `payeeId` in the group,
 * and keeps the settlement `pending` with the provider's payment id and `payUrl`; answers the settlement's id.
 * The id is the payment's reference at the provider.
 *
 * The rules of {@link checkSettlement} are checked first, so a refused request never reaches the provider.
 * Refused with `404` when the payer is not a member of the group, with `422` when the payee is not a member of
 * the group, and as {@link checkSettlement} says otherwise. A payee with no payout account (see
 * `payout-accounts.ts`) is refused with `409` as `PayoutAccountRequired`, before the provider is asked: the
 * payment is made to the payee's payout account, as it is at this moment. Refused with `424` when paying through
 * the provider is not configured, or when the provider does not answer a payment in time (see
 * {@link requestPayment}); then nothing is kept.
 *
 * The provider is asked outside any transaction, so that no write is held while it answers; the rules are
 * checked again in the transaction that keeps the settlement, so two requests at once cannot both pay more
 * than is owed. If the rules refuse at that second check, the provider has made a payment Tally never keeps: its
 * webhooks name a payment Tally does not know, so they change nothing.
 */
export async function requestProviderSettlement(
  db: DatabaseSync,
  provider: ProviderConfig,
  input: { groupId: string; payerId: string; payeeId: string; amount: number },
): Promise<string> {
  const { groupId, payerId, payeeId, amount } = input;
  const decide = (): { currency: string; payee: string } => {
    const group = findGroupOfMember(db, payerId, groupId);
    if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    if (!membersOfGroup(db, groupId).some(member => member.memberId === payeeId)) {
      throw new Refusal(422, 'PayeeNotInGroup', 'The payee must be a member of the group.');
    }
    checkSettlement(db, { groupId, payerId, payeeId, amount });
    const payee = payoutAccountOf(db, payeeId);
    if (payee === undefined) {
      throw new Refusal(
        409,
        'PayoutAccountRequired',
        'The member who is paid must have a payout account to be paid through the provider.',
      );
    }
    return { currency: group.currency, payee };
  };

  const { currency, payee } = inReadSnapshot(db, decide);
  const id = randomUUID();
  const payment = await requestPayment(provider, { reference: id, amount, currency, payee });
  inTransaction(db, () => {
    decide();
    db.prepare(
      'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, provider_payment_id, pay_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      groupId,
      payerId,
      payeeId,
      amount,
      'provider',
      'pending',
      payment.id,
      payment.payUrl,
      new Date().toISOString(),
    );
  });
  return id;
}

/**
 * What the provider's word on a payment moves a settlement to, and from which statuses it does. Each status is
 * a step forward, and a payment that has ended keeps its status: `succeeded` ends a `pending` payment as `paid`,
 * `failed` ends one as `failed`, and `refunded` ends a payment as `refunded` from `pending` (a refund that
 * overtakes the success it follows), from `paid`, or from `refunding` (the refund Tally asked for).
 */
const PROVIDER_OUTCOMES = new Map<string, { to: Settlement['status']; from: string }>([
  ['succeeded', { to: 'paid', from: `'pending'` }],
  ['failed', { to: 'failed', from: `'pending'` }],
  ['refunded', { to: 'refunded', from: `'pending', 'paid', 'refunding'` }],
]);

/**
 * Applies the provider's word on a payment (see {@link PROVIDER_OUTCOMES}). A settlement moves once, forward: a
 * webhook saying a status the settlement has passed, or has gone past, changes nothing, and a `refunded` said
 * twice counts once. `pending`, and any payment Tally does not know, change nothing. Answers nothing; the webhook
 * is acknowledged either way.
 */
export function recordProviderOutcome(db: DatabaseSync, input: { paymentId: string; status: string }): void {
  const outcome = PROVIDER_OUTCOMES.get(input.status);
  if (outcome === undefined) return;
  // The statuses are constants chosen here, never values from a webhook.
  db.prepare(
    `UPDATE settlements SET status = ?
     WHERE method = 'provider' AND provider_payment_id = ? AND status IN (${outcome.from})`,
  ).run(outcome.to, input.paymentId);
}

/**
 * The settlements whose refund is being asked of the provider, by id, in this process: a second refund of one
 * asked meanwhile is refused, so the provider is not asked to refund the same payment twice at once.
 */
const refundsInFlight = new Set<string>();
const REFUND_IN_PROGRESS = 'A refund of this settlement is already being asked of the provider.';

/**
 * Asks the payment provider to refund the settlement `settlementId`, which `accountId` (the caller) must be the
 * payee of, and records it `refunding`: the money has not gone back yet, so the balances still count it as paid,
 * until the provider says it is `refunded` (see {@link recordProviderOutcome}).
 *
 * Refused with `404` when the caller is not a current member of the settlement's group, as if it did not exist;
 * with `403` when the caller is not the payee; with `409` when the settlement was paid in cash, when it is not
 * `paid` (a refund is asked once), when the payer or the payee has left the group (so the balances would not add
 * up to 0 once refunded), or when a refund of it is already being asked; with `424` when the provider is not
 * configured or does not answer a refund in time (see {@link requestRefund}), and then nothing changes.
 *
 * The rules are checked, first to refuse early and again once the claim is taken, then the provider is asked
 * outside any transaction, so no write is held while it answers. The rules are not checked once the provider has
 * answered: a refund it has made is recorded, since refusing it would not undo the refund. A `refunded` webhook
 * that arrives before that is kept, since the settlement is then `refunded` already.
 */
export async function refundSettlement(
  db: DatabaseSync,
  provider: ProviderConfig,
  input: { settlementId: string; accountId: string },
): Promise<void> {
  const { settlementId, accountId } = input;
  // Refused as the rules say before anything is claimed, so a request that may not refund learns nothing of
  // a refund in progress.
  inReadSnapshot(db, () => refundablePayment(db, accountId, settlementId));
  if (refundsInFlight.has(settlementId)) throw new Refusal(409, 'RefundIsInProgress', REFUND_IN_PROGRESS);
  refundsInFlight.add(settlementId);
  try {
    // Read again under the claim: a refund that finished before this one claimed the settlement is seen as not paid.
    const paymentId = inReadSnapshot(db, () => refundablePayment(db, accountId, settlementId));
    await requestRefund(provider, { paymentId, reference: settlementId });
    // A `refunded` that arrived meanwhile stays: it is `refunded` already, and only a `paid` settlement moves on.
    inTransaction(db, () => {
      db.prepare(`UPDATE settlements SET status = 'refunding' WHERE id = ? AND status = 'paid'`).run(settlementId);
    });
  } finally {
    refundsInFlight.delete(settlementId);
  }
}

/**
 * The provider's id of the payment of the settlement, when `accountId` may ask for its refund now; refused as
 * {@link refundSettlement} says otherwise.
 */
function refundablePayment(db: DatabaseSync, accountId: string, settlementId: string): string {
  const row = db
    .prepare(
      `SELECT s.group_id, s.payer_id, s.payee_id, s.method, s.status, s.provider_payment_id FROM settlements s
       JOIN group_members m ON m.group_id = s.group_id
       WHERE s.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get(settlementId, accountId) as
    | {
        group_id: string;
        payer_id: string;
        payee_id: string;
        method: Settlement['method'];
        status: Settlement['status'];
        provider_payment_id: string | null;
      }
    | undefined;
  if (!row) throw new Refusal(404, 'SettlementNotFound', 'No settlement has this id.');
  if (row.payee_id !== accountId) {
    throw new Refusal(403, 'NotThePayee', 'Only the member who was paid can refund the settlement.');
  }
  if (row.method !== 'provider' || row.provider_payment_id === null) {
    throw new Refusal(409, 'NotPaidThroughProvider', 'A settlement in cash is not refunded through Tally.');
  }
  if (row.status !== 'paid') {
    throw new Refusal(409, 'SettlementIsNotPaid', 'Only a settlement that is paid can be refunded.');
  }
  const members = membersOfGroup(db, row.group_id).map(member => member.memberId);
  if (!members.includes(row.payer_id) || !members.includes(row.payee_id)) {
    throw new Refusal(409, 'MemberHasLeft', 'Both members of the settlement must be in the group to refund it.');
  }
  return row.provider_payment_id;
}

/**
 * The settlement with this id, when `accountId` is a current member of its group; `undefined` otherwise,
 * as if it did not exist. Reading never changes it.
 */
export function findSettlementOfMember(
  db: DatabaseSync,
  accountId: string,
  settlementId: string,
): Settlement | undefined {
  const row = db
    .prepare(
      `SELECT ${SETTLEMENT_COLUMNS} FROM settlements s
       JOIN group_members m ON m.group_id = s.group_id
       WHERE s.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get(settlementId, accountId) as SettlementRow | undefined;
  return row && settlementOf(row);
}
