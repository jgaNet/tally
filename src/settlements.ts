import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type Balance, balancesOfGroup } from './balances';
import { findGroupOfMember, membersOfGroup } from './groups';
import { type ProviderConfig, requestPayment } from './provider';
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
  /** `pending` while the provider has not ended the payment; `failed` when it failed, and it never counts. */
  readonly status: 'pending' | 'paid' | 'failed';
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
  status: 'pending' | 'paid' | 'failed';
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
 * the group, and as {@link checkSettlement} says otherwise. Refused with `424` when paying through the provider
 * is not configured, or when the provider does not answer a payment in time (see {@link requestPayment}); then
 * nothing is kept.
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
  const decide = (): { currency: string } => {
    const group = findGroupOfMember(db, payerId, groupId);
    if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    if (!membersOfGroup(db, groupId).some(member => member.memberId === payeeId)) {
      throw new Refusal(422, 'PayeeNotInGroup', 'The payee must be a member of the group.');
    }
    checkSettlement(db, { groupId, payerId, payeeId, amount });
    return { currency: group.currency };
  };

  const { currency } = inReadSnapshot(db, decide);
  const id = randomUUID();
  const payment = await requestPayment(provider, { reference: id, amount, currency });
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
 * Applies the provider's word on a payment: `succeeded` makes the settlement `paid`, `failed` makes it `failed`.
 * A settlement moves only from `pending`, once: a payment that has ended keeps its status, whatever a later
 * webhook says. `pending`, and any payment Tally does not know, change nothing. Answers nothing; the webhook is
 * acknowledged either way.
 */
export function recordProviderOutcome(db: DatabaseSync, input: { paymentId: string; status: string }): void {
  const status = input.status === 'succeeded' ? 'paid' : input.status === 'failed' ? 'failed' : undefined;
  if (status === undefined) return;
  db.prepare(
    `UPDATE settlements SET status = ? WHERE method = 'provider' AND status = 'pending' AND provider_payment_id = ?`,
  ).run(status, input.paymentId);
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
