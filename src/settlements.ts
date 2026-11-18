import { randomUUID } from 'node:crypto';
import { recordAdminLog } from './admin-log';
import { recordAudit } from './audit';
import { type Balance, balancesOfGroup } from './balances';
import type { Database, Querier } from './database';
import { assertNotArchived, CURRENCIES, findGroup, findGroupOfMember, membersOfGroup, type Currency } from './groups';
import { type ProviderConfig, requestPayment, requestRefund } from './provider';
import { payoutAccountOf } from './payout-accounts';
import { feeBearerOfGroup } from './fee-policy';
import { type Fee, type FeeBearer, feeOfRow, settledOfRow } from './fees';
import { convertedAmount, MAX_AMOUNT, MIN_AMOUNT, type OriginalAmount } from './expenses';
import { offeredRate, type RatesConfig } from './rates';
import { todayInUtc } from './days';
import { assertNotDeleted } from './accounts';
import { assertNotSuspended } from './suspensions';
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
 * `404`, as if the group did not exist). It reads one consistent state of the database and changes nothing: a
 * suggestion records nothing, and the balances stay what the expenses and the paid settlements make them.
 * A settlement waiting at the payment provider counts as paid here, so the suggestion leaves it out.
 */
export async function suggestedSettlement(db: Database, readerId: string, groupId: string): Promise<Transfer[]> {
  return inReadSnapshot(db, async snapshot => {
    if (!(await findGroupOfMember(snapshot, readerId, groupId))) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    return suggestTransfers(await balancesOfGroup(snapshot, groupId, { includePending: true }));
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
  readonly method: 'cash' | 'provider' | 'net';
  /**
   * `pending` while the provider has not ended the payment; `failed` when it failed, and it never counts. A `paid`
   * one is `refunding` once its refund is asked of the provider, and `refunded` once the provider says so. A `paid`
   * one through the provider is `contested` once its payee says the money did not arrive, and then `paid` again, or
   * `annulled` (it never counts), as an administrator decides.
   */
  readonly status: 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'contested' | 'annulled';
  readonly at: string;
  /** The link where the payer pays, through the provider; a settlement in cash has none. */
  readonly payUrl?: string;
  /**
   * The provider's fee on a settlement through the provider asked for from request 38 on: the fee the provider said, and who
   * bore it, as the payment was asked for. Absent otherwise. What the settlement settles is its amount less the payer's part
   * of the fee (see `fees.ts`); its `amount` stays the one asked for.
   */
  readonly fee?: Fee;
  /**
   * What a settlement in another currency was paid in (requested from request 39 on): its currency and amount, and the rate it
   * was decided at, which the rates service offered that day and which is kept whatever it says later. Its `amount` is the
   * original amount at that rate, in the group's currency. Absent for a settlement in the group's currency.
   */
  readonly original?: OriginalAmount;
  /** Every status the settlement has had, the earliest first: at least one, the status it has now or had last. */
  readonly history: readonly StatusChange[];
}

/** A status a settlement has had, and when Tally learned it. */
export interface StatusChange {
  readonly status: Settlement['status'];
  readonly at: string;
}

/** The statuses a settlement is recorded with, as the history rows of the database hold them. */
interface StatusRow {
  settlement_id: string;
  status: Settlement['status'];
  at: string;
}

/** Records that the settlement `settlementId` had `status`, learned at `at`. Written in the caller's transaction. */
export async function recordStatus(
  db: Querier,
  settlementId: string,
  status: Settlement['status'],
  at: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO settlement_statuses (settlement_id, status, at) VALUES (?, ?, ?)')
    .run(settlementId, status, at);
}

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: 'cash' | 'provider' | 'net';
  status: Settlement['status'];
  provider_payment_id: string | null;
  pay_url: string | null;
  fee_amount: number | null;
  fee_borne_by: FeeBearer | null;
  original_currency: Currency | null;
  original_amount: number | null;
  original_rate: string | null;
  created_at: string;
}

const SETTLEMENT_COLUMNS =
  's.id, s.group_id, s.payer_id, s.payee_id, s.amount, s.method, s.status, s.pay_url, s.fee_amount, s.fee_borne_by, s.original_currency, s.original_amount, s.original_rate, s.created_at';

/** The columns of a settlement that say what it settles: its amount, and the fee it keeps, if any (see `fees.ts`). */
const FEE_COLUMNS = 'amount, fee_amount, fee_borne_by';

function settlementOf(row: SettlementRow, history: readonly StatusChange[]): Settlement {
  const settlement = {
    id: row.id,
    groupId: row.group_id,
    from: row.payer_id,
    to: row.payee_id,
    amount: Number(row.amount),
    method: row.method,
    status: row.status,
    at: row.created_at,
    history,
  };
  const withPayUrl = row.pay_url === null ? settlement : { ...settlement, payUrl: row.pay_url };
  const fee = feeOfRow(row);
  const withFee = fee === undefined ? withPayUrl : { ...withPayUrl, fee };
  const original = originalOfRow(row);
  return original === undefined ? withFee : { ...withFee, original };
}

/** What a settlement row was paid in, when it was paid in another currency (see {@link Settlement}); `undefined` otherwise. */
function originalOfRow(
  row: Pick<SettlementRow, 'original_currency' | 'original_amount' | 'original_rate'>,
): OriginalAmount | undefined {
  if (row.original_currency === null || row.original_amount === null || row.original_rate === null) return undefined;
  return { currency: row.original_currency, amount: Number(row.original_amount), rate: row.original_rate };
}

/** The history of each settlement of the group, the earliest status first, by settlement id. */
async function historiesOf(db: Querier, groupId: string): Promise<Map<string, StatusChange[]>> {
  const rows = await db
    .prepare(
      `SELECT settlement_id, status, at FROM settlement_statuses
       WHERE settlement_id IN (SELECT id FROM settlements WHERE group_id = ?) ORDER BY seq ASC`,
    )
    .all<StatusRow>(groupId);
  const histories = new Map<string, StatusChange[]>();
  for (const row of rows) {
    const history = histories.get(row.settlement_id) ?? [];
    history.push({ status: row.status, at: row.at });
    histories.set(row.settlement_id, history);
  }
  return histories;
}

/**
 * The rules a settlement of `amount` from `payerId` to `payeeId` in the group must meet, checked on the balances
 * as they stand, with a settlement waiting at the provider counted as paid: a whole number from 1; the payer is
 * not the payee; the payer is a member of the group; and the amount is not more than the payer still owes, nor
 * more than the payee is still owed. Refused with `422` or `409` otherwise.
 */
async function checkSettlement(
  db: Querier,
  input: { groupId: string; payerId: string; payeeId: string; amount: number },
): Promise<void> {
  const { groupId, payerId, payeeId, amount } = input;
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Refusal(422, 'AmountIsInvalid', 'The amount must be a whole number, at least 1.');
  }
  if (payerId === payeeId) {
    throw new Refusal(422, 'PayerIsPayee', 'The member who paid cannot be the member who was paid.');
  }
  if (!(await membersOfGroup(db, groupId)).some(member => member.memberId === payerId)) {
    throw new Refusal(422, 'PayerNotInGroup', 'The payer must be a member of the group.');
  }
  const balances = await balancesOfGroup(db, groupId, { includePending: true });
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
 * A settlement's amount as it is asked for: in the group's currency, or `original`, in another of Tally's currencies, which is
 * settled at the rate decided when it is asked for (see {@link decidedAmount}).
 */
export type SettlementAmount =
  | { readonly kind: 'group'; readonly amount: number }
  | { readonly kind: 'original'; readonly currency: string; readonly amount: number };

/** What a settlement settles, in the group's currency, and what it was paid in when that is another currency. */
interface DecidedAmount {
  readonly amount: number;
  readonly original: OriginalAmount | undefined;
}

/**
 * The amount a settlement in the group settles, as it is decided now by `accountId`, a member of the group. An amount in the
 * group's currency is taken as it is. One in another currency is its original amount at the rate the rates service offers from
 * its currency to the group's on today's day (UTC), converted to the group's currency to the nearest whole number, a half up
 * (see {@link convertedAmount}), and kept with the rate it was decided at; the payer gives no rate. The rate is asked outside
 * any transaction, so no write is held while it answers, and nothing is kept here.
 *
 * Refused with `404` when `accountId` is not a member of the group, as if it did not exist, and as the archiving of a group
 * says when it is archived; with `422` as `CurrencyIsUnsupported` when the currency is not one of Tally's, as
 * `CurrencyIsTheGroupsCurrency` when it is the group's own, as `OriginalAmountIsInvalid` when the original amount is not a whole
 * number from 1 to 100 000 000, as `RateIsNotOffered` when no rate is offered from the currency on the day, and as `AmountIsInvalid`
 * when the amount in the group's currency is not from 1 to 100 000 000. Refused, nothing is kept and the provider is not asked.
 */
async function decidedAmount(
  db: Querier,
  rates: RatesConfig,
  groupId: string,
  accountId: string,
  given: SettlementAmount,
): Promise<DecidedAmount> {
  if (given.kind === 'group') return { amount: given.amount, original: undefined };
  const group = await findGroupOfMember(db, accountId, groupId);
  if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
  assertNotArchived(group);
  const { currency, amount: originalAmount } = given;
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    throw new Refusal(422, 'CurrencyIsUnsupported', `The currency must be one of ${CURRENCIES.join(', ')}.`);
  }
  if (currency === group.currency) {
    throw new Refusal(
      422,
      'CurrencyIsTheGroupsCurrency',
      `A settlement in the group's currency, ${group.currency}, is given with its amount, not with another currency.`,
    );
  }
  if (!Number.isSafeInteger(originalAmount) || originalAmount < MIN_AMOUNT || originalAmount > MAX_AMOUNT) {
    throw new Refusal(
      422,
      'OriginalAmountIsInvalid',
      `The original amount must be a whole number from ${MIN_AMOUNT} to ${MAX_AMOUNT}.`,
    );
  }
  const rate = await offeredRate(rates, { from: currency, to: group.currency, date: todayInUtc() });
  if (rate === undefined) {
    throw new Refusal(
      422,
      'RateIsNotOffered',
      `No rate is offered from ${currency} to ${group.currency} on this day, so the settlement cannot be decided.`,
    );
  }
  const amount = convertedAmount(originalAmount, rate);
  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    throw new Refusal(
      422,
      'AmountIsInvalid',
      `The original amount at its rate must be a whole number from ${MIN_AMOUNT} to ${MAX_AMOUNT} in the group's currency.`,
    );
  }
  return { amount, original: { currency: currency as Currency, amount: originalAmount, rate } };
}

/** The columns a settlement keeps what it was paid in, in the order of the columns: all `null` in the group's currency. */
function originalColumns(original: OriginalAmount | undefined): [string | null, number | null, string | null] {
  return original ? [original.currency, original.amount, original.rate] : [null, null, null];
}

/**
 * Records that `payerId` paid `payeeId` the amount in cash, in the group, and answers its id. The payee is the member who
 * records it. The amount is in the group's currency, or in another currency at the rate offered on the day (see
 * {@link decidedAmount}), which the settlement keeps. Refused with `404` when the payee is not a member of the group; with `422`
 * when the amount is not a whole number from 1, when the payer is the payee, or when the payer is not a member of the group;
 * with `409` when the amount is more than the payer owes (the opposite of their balance) or more than the payee is owed (their
 * balance), on the balances as they stand, a settlement waiting at the provider counted as paid. Refused as
 * {@link decidedAmount} says when the amount is in another currency. The balances are read and the settlement written in one
 * transaction, so two settlements recorded at once are each decided on the balances the other left: when both would pay more
 * than is owed, one is refused. A payee who is suspended is refused with `403` as `AccountIsSuspended`, before anything is written.
 */
export async function recordCashSettlement(
  db: Database,
  rates: RatesConfig,
  input: { groupId: string; payeeId: string; payerId: string; amount: SettlementAmount },
): Promise<string> {
  const { groupId, payeeId, payerId } = input;
  const decided = await decidedAmount(db, rates, groupId, payeeId, input.amount);
  const id = randomUUID();
  await inTransaction(db, async tx => {
    const group = await findGroupOfMember(tx, payeeId, groupId);
    if (!group) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    assertNotArchived(group);
    await assertNotSuspended(tx, payeeId);
    await checkSettlement(tx, { groupId, payerId, payeeId, amount: decided.amount });
    const at = new Date().toISOString();
    await tx
      .prepare(
        'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, original_currency, original_amount, original_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, groupId, payerId, payeeId, decided.amount, 'cash', 'paid', ...originalColumns(decided.original), at);
    await recordStatus(tx, id, 'paid', at);
    // Paid in cash, the balances start to count it at once: its payee, who records it, made the change.
    await recordAudit(tx, {
      groupId,
      at,
      by: payeeId,
      action: 'settlement-paid',
      subjectId: id,
      amount: decided.amount,
    });
  });
  return id;
}

/**
 * Asks the payment provider for a payment from `payerId` (the caller) to `payeeId` in the group, of the amount in the group's
 * currency, or of the original amount in another currency at the rate offered on the day (see {@link decidedAmount}): the payment
 * is asked in that currency, and its fee is converted at that rate. It keeps the settlement `pending` with the provider's payment
 * id, its `payUrl` and the fee the provider said, with who
 * bears that fee as the group's policy stands now (see `fee-policy.ts`); answers the settlement's id. The id is the
 * payment's reference at the provider.
 *
 * The rules of {@link checkSettlement} are checked first, so a refused request never reaches the provider.
 * Refused with `404` when the payer is not a member of the group, with `422` when the payee is not a member of
 * the group, and as {@link checkSettlement} says otherwise. A payee with no payout account (see
 * `payout-accounts.ts`) is refused with `409` as `PayoutAccountRequired`, before the provider is asked: the
 * payment is made to the payee's payout account, as it is at this moment. Refused with `424` when paying through
 * the provider is not configured, or when the provider does not answer a payment in time, or without a fee it keeps that is
 * a whole number from 0 and less than the amount (see {@link requestPayment}); then nothing is kept. Refused with `403` as `AccountIsSuspended` when the payer is suspended,
 * before the provider is asked.
 *
 * The provider is asked outside any transaction, so that no write is held while it answers; the rules are
 * checked again in the transaction that keeps the settlement, so two requests at once cannot both pay more
 * than is owed. If the rules refuse at that second check, the provider has made a payment Tally never keeps: its
 * webhooks name a payment Tally does not know, so they change nothing.
 */
export async function requestProviderSettlement(
  db: Database,
  provider: ProviderConfig,
  rates: RatesConfig,
  input: { groupId: string; payerId: string; payeeId: string; amount: SettlementAmount },
): Promise<string> {
  const { groupId, payerId, payeeId } = input;
  // The amount is decided first: in another currency, at the rate offered on this day, which the settlement keeps.
  const { amount, original } = await decidedAmount(db, rates, groupId, payerId, input.amount);
  const decide = async (querier: Querier): Promise<{ currency: string; payee: string; borneBy: FeeBearer }> => {
    const group = await findGroupOfMember(querier, payerId, groupId);
    if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    assertNotArchived(group);
    await assertNotSuspended(querier, payerId);
    if (!(await membersOfGroup(querier, groupId)).some(member => member.memberId === payeeId)) {
      throw new Refusal(422, 'PayeeNotInGroup', 'The payee must be a member of the group.');
    }
    await assertNotDeleted(querier, payeeId);
    await checkSettlement(querier, { groupId, payerId, payeeId, amount });
    const payee = await payoutAccountOf(querier, payeeId);
    if (payee === undefined) {
      throw new Refusal(
        409,
        'PayoutAccountRequired',
        'The member who is paid must have a payout account to be paid through the provider.',
      );
    }
    return { currency: group.currency, payee, borneBy: await feeBearerOfGroup(querier, groupId) };
  };

  // Who bears the fee is the group's policy as the payment is asked for; the settlement keeps it from then on.
  const { currency, payee, borneBy } = await inReadSnapshot(db, decide);
  const id = randomUUID();
  // The payment is asked in the currency of the original amount, when the settlement has one.
  const payment = await requestPayment(provider, {
    reference: id,
    amount: original?.amount ?? amount,
    currency: original?.currency ?? currency,
    payee,
  });
  // The fee the provider keeps is in the payment's currency: it is converted at the settlement's rate, as its amount is.
  const fee = original === undefined ? payment.fee : convertedAmount(payment.fee, original.rate);
  // A fee in the group's currency that is not less than the amount cannot be kept (the settlement's rules forbid it). The
  // provider has made the payment already, which its webhooks name as one Tally does not know: they change nothing.
  if (fee >= amount) {
    throw new Refusal(
      424,
      'FeeIsNotLessThanAmount',
      'The payment provider’s fee, in the group’s currency, is not less than the amount. Nothing was kept.',
    );
  }
  await inTransaction(db, async tx => {
    await decide(tx);
    const at = new Date().toISOString();
    await tx
      .prepare(
        'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, provider_payment_id, pay_url, fee_amount, fee_borne_by, original_currency, original_amount, original_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        groupId,
        payerId,
        payeeId,
        amount,
        'provider',
        'pending',
        payment.id,
        payment.payUrl,
        fee,
        borneBy,
        ...originalColumns(original),
        at,
      );
    await recordStatus(tx, id, 'pending', at);
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
export async function recordProviderOutcome(db: Database, input: { paymentId: string; status: string }): Promise<void> {
  const outcome = PROVIDER_OUTCOMES.get(input.status);
  if (outcome === undefined) return;
  // The statuses are constants chosen here, never values from a webhook. What is moved is found and moved in one
  // transaction, so each settlement that moves is recorded in its history, and one that does not is not.
  await inTransaction(db, async tx => {
    const moved = await tx
      .prepare(
        `SELECT id, group_id, payer_id, payee_id, ${FEE_COLUMNS}, status FROM settlements
         WHERE method = 'provider' AND provider_payment_id = ? AND status IN (${outcome.from})
           AND group_id NOT IN (SELECT id FROM groups WHERE archived_at IS NOT NULL)`,
      )
      .all<{
        id: string;
        group_id: string;
        payer_id: string;
        payee_id: string;
        amount: number;
        fee_amount: number | null;
        fee_borne_by: FeeBearer | null;
        status: Settlement['status'];
      }>(input.paymentId);
    const at = new Date().toISOString();
    for (const row of moved) {
      await tx.prepare('UPDATE settlements SET status = ? WHERE id = ?').run(outcome.to, row.id);
      await recordStatus(tx, row.id, outcome.to, at);
      // The balances count a settlement from its success, paid through the provider by its payer, until a refund
      // takes it back: a refund of a payment still pending never counted, so it changes no balance and has no entry.
      if (outcome.to === 'paid') {
        await recordAudit(tx, {
          groupId: row.group_id,
          at,
          by: row.payer_id,
          action: 'settlement-paid',
          subjectId: row.id,
          amount: settledOfRow(row),
        });
      } else if (outcome.to === 'refunded' && row.status !== 'pending') {
        await recordAudit(tx, {
          groupId: row.group_id,
          at,
          by: row.payee_id,
          action: 'settlement-refunded',
          subjectId: row.id,
          amount: settledOfRow(row),
        });
      }
    }
  });
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
  db: Database,
  provider: ProviderConfig,
  input: { settlementId: string; accountId: string },
): Promise<void> {
  const { settlementId, accountId } = input;
  // Refused as the rules say before anything is claimed, so a request that may not refund learns nothing of
  // a refund in progress.
  await inReadSnapshot(db, snapshot => refundablePayment(snapshot, accountId, settlementId));
  if (refundsInFlight.has(settlementId)) throw new Refusal(409, 'RefundIsInProgress', REFUND_IN_PROGRESS);
  refundsInFlight.add(settlementId);
  try {
    // Read again under the claim: a refund that finished before this one claimed the settlement is seen as not paid.
    const paymentId = await inReadSnapshot(db, snapshot => refundablePayment(snapshot, accountId, settlementId));
    await requestRefund(provider, { paymentId, reference: settlementId });
    // A `refunded` that arrived meanwhile stays: it is `refunded` already, and only a `paid` settlement moves on.
    await inTransaction(db, async tx => {
      const { changes } = await tx
        .prepare(`UPDATE settlements SET status = 'refunding' WHERE id = ? AND status = 'paid'`)
        .run(settlementId);
      if (changes === 1) await recordStatus(tx, settlementId, 'refunding', new Date().toISOString());
    });
  } finally {
    refundsInFlight.delete(settlementId);
  }
}

/**
 * The provider's id of the payment of the settlement, when `accountId` may ask for its refund now; refused as
 * {@link refundSettlement} says otherwise.
 */
async function refundablePayment(db: Querier, accountId: string, settlementId: string): Promise<string> {
  const row = await db
    .prepare(
      `SELECT s.group_id, s.payer_id, s.payee_id, s.method, s.status, s.provider_payment_id FROM settlements s
       JOIN group_members m ON m.group_id = s.group_id
       WHERE s.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get<{
      group_id: string;
      payer_id: string;
      payee_id: string;
      method: Settlement['method'];
      status: Settlement['status'];
      provider_payment_id: string | null;
    }>(settlementId, accountId);
  if (!row) throw new Refusal(404, 'SettlementNotFound', 'No settlement has this id.');
  const group = await findGroup(db, row.group_id);
  if (group) assertNotArchived(group);
  if (row.payee_id !== accountId) {
    throw new Refusal(403, 'NotThePayee', 'Only the member who was paid can refund the settlement.');
  }
  if (row.method !== 'provider' || row.provider_payment_id === null) {
    throw new Refusal(
      409,
      'NotPaidThroughProvider',
      'A settlement in cash or by netting is not refunded through Tally.',
    );
  }
  if (row.status !== 'paid') {
    throw new Refusal(409, 'SettlementIsNotPaid', 'Only a settlement that is paid can be refunded.');
  }
  const members = (await membersOfGroup(db, row.group_id)).map(member => member.memberId);
  if (!members.includes(row.payer_id) || !members.includes(row.payee_id)) {
    throw new Refusal(409, 'MemberHasLeft', 'Both members of the settlement must be in the group to refund it.');
  }
  return row.provider_payment_id;
}

/**
 * The settlement with this id, when `accountId` is a current member of its group; `undefined` otherwise,
 * as if it did not exist. Reading never changes it.
 */
export async function findSettlementOfMember(
  db: Querier,
  accountId: string,
  settlementId: string,
): Promise<Settlement | undefined> {
  const row = await db
    .prepare(
      `SELECT ${SETTLEMENT_COLUMNS} FROM settlements s
       JOIN group_members m ON m.group_id = s.group_id
       WHERE s.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get<SettlementRow>(settlementId, accountId);
  if (!row) return undefined;
  const history = await db
    .prepare('SELECT status, at FROM settlement_statuses WHERE settlement_id = ? ORDER BY seq ASC')
    .all<Omit<StatusRow, 'settlement_id'>>(row.id);
  return settlementOf(
    row,
    history.map(change => ({ status: change.status, at: change.at })),
  );
}

/**
 * Every settlement of the group, as a current member of the group reads each (see {@link findSettlementOfMember}),
 * the most recently recorded or asked for first; a settlement of a member who has left is among them. Refused with
 * `404` when `readerId` is not a current member of the group, as if it did not exist. It reads one consistent state
 * of the database and changes nothing.
 */
export async function settlementsOfGroup(db: Database, readerId: string, groupId: string): Promise<Settlement[]> {
  return inReadSnapshot(db, async snapshot => {
    if (!(await findGroupOfMember(snapshot, readerId, groupId))) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    const rows = await snapshot
      .prepare(
        `SELECT ${SETTLEMENT_COLUMNS} FROM settlements s
         WHERE s.group_id = ? ORDER BY s.created_at DESC, s.seq DESC`,
      )
      .all<SettlementRow>(groupId);
    const histories = await historiesOf(snapshot, groupId);
    return rows.map(row => settlementOf(row, histories.get(row.id) ?? []));
  });
}

/**
 * Contests the settlement `settlementId`, which `accountId` (the caller) must be the payee of: the payee says the money did
 * not reach them. Only a settlement through the provider that is `paid` is contested, and once: a settlement contested before,
 * even one an administrator has decided was paid, is refused. Its payer and payee must be current members of the group, and
 * the group must not be archived.
 *
 * It is `contested` from then on: the balances do not count it, as they were before it was paid, while the rules that wait
 * for a payment at the provider still count it as paid (see `balances.ts`). A webhook about its payment changes nothing.
 * It is recorded in its history, and in the audit of the group as a `settlement-contested` by its payee, with its amount.
 *
 * Refused with `404` when the caller is not a current member of the settlement's group, as if it did not exist; with `409`
 * as `GroupIsArchived` when the group is archived; with `403` as `NotThePayee` when the caller is not the payee; with `409`
 * as `NotPaidThroughProvider` when the settlement was not paid through the provider, as `SettlementIsNotPaid` when it is not
 * `paid`, as `SettlementWasContested` when it was contested before, as `RefundIsInProgress` when a refund of it is being asked
 * of the provider, and as `MemberHasLeft` when its payer or payee has left the group. Refused, nothing changes.
 *
 * The check and the contest are one transaction, so two contests at once cannot both be made.
 */
export async function contestSettlement(
  db: Database,
  input: { settlementId: string; accountId: string },
): Promise<void> {
  const { settlementId, accountId } = input;
  await inTransaction(db, async tx => {
    const row = await tx
      .prepare(
        `SELECT s.group_id, s.payer_id, s.payee_id, s.amount, s.fee_amount, s.fee_borne_by, s.method, s.status FROM settlements s
         JOIN group_members m ON m.group_id = s.group_id
         WHERE s.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
      )
      .get<{
        group_id: string;
        payer_id: string;
        payee_id: string;
        amount: number;
        fee_amount: number | null;
        fee_borne_by: FeeBearer | null;
        method: Settlement['method'];
        status: Settlement['status'];
      }>(settlementId, accountId);
    if (!row) throw new Refusal(404, 'SettlementNotFound', 'No settlement has this id.');
    const group = await findGroup(tx, row.group_id);
    if (group) assertNotArchived(group);
    if (row.payee_id !== accountId) {
      throw new Refusal(403, 'NotThePayee', 'Only the member who was paid can contest the settlement.');
    }
    if (row.method !== 'provider') {
      throw new Refusal(409, 'NotPaidThroughProvider', 'Only a settlement paid through the provider can be contested.');
    }
    if (row.status !== 'paid') {
      throw new Refusal(409, 'SettlementIsNotPaid', 'Only a settlement that is paid can be contested.');
    }
    const contestedBefore = await tx
      .prepare(`SELECT 1 FROM settlement_statuses WHERE settlement_id = ? AND status = 'contested'`)
      .get(settlementId);
    if (contestedBefore !== undefined) {
      throw new Refusal(409, 'SettlementWasContested', 'A settlement is contested once.');
    }
    if (refundsInFlight.has(settlementId)) throw new Refusal(409, 'RefundIsInProgress', REFUND_IN_PROGRESS);
    const members = (await membersOfGroup(tx, row.group_id)).map(member => member.memberId);
    if (!members.includes(row.payer_id) || !members.includes(row.payee_id)) {
      throw new Refusal(409, 'MemberHasLeft', 'Both members of the settlement must be in the group to contest it.');
    }
    const at = new Date().toISOString();
    await tx.prepare(`UPDATE settlements SET status = 'contested' WHERE id = ?`).run(settlementId);
    await recordStatus(tx, settlementId, 'contested', at);
    await recordAudit(tx, {
      groupId: row.group_id,
      at,
      by: accountId,
      action: 'settlement-contested',
      subjectId: settlementId,
      amount: settledOfRow(row),
    });
  });
}

/**
 * The administrator `administratorId` decides the contested settlement `settlementId`: `paid` when the money arrived, which
 * makes it `paid` again and counted as it was before it was contested (its `settlement-paid` audit entry is by the
 * administrator); otherwise `annulled`, which nothing counts any more, so what was owed is owed again. Either way the decision
 * is entered in the administrators' log (see `admin-log.ts`).
 *
 * Refused with `404` when there is no settlement with this id, and with `409` as `SettlementIsNotContested` when it is not
 * contested: only a contested settlement is decided, once. The check and the decision are one transaction.
 */
export async function decideContest(
  db: Database,
  input: { settlementId: string; administratorId: string; paid: boolean },
): Promise<void> {
  const { settlementId, administratorId, paid } = input;
  await inTransaction(db, async tx => {
    const row = await tx.prepare(`SELECT group_id, ${FEE_COLUMNS}, status FROM settlements WHERE id = ?`).get<{
      group_id: string;
      amount: number;
      fee_amount: number | null;
      fee_borne_by: FeeBearer | null;
      status: Settlement['status'];
    }>(settlementId);
    if (!row) throw new Refusal(404, 'SettlementNotFound', 'No settlement has this id.');
    if (row.status !== 'contested') {
      throw new Refusal(409, 'SettlementIsNotContested', 'Only a contested settlement is decided.');
    }
    const at = new Date().toISOString();
    const status = paid ? 'paid' : 'annulled';
    await tx.prepare('UPDATE settlements SET status = ? WHERE id = ?').run(status, settlementId);
    await recordStatus(tx, settlementId, status, at);
    if (paid) {
      await recordAudit(tx, {
        groupId: row.group_id,
        at,
        by: administratorId,
        action: 'settlement-paid',
        subjectId: settlementId,
        amount: settledOfRow(row),
      });
    }
    await recordAdminLog(tx, {
      at,
      by: administratorId,
      action: paid ? 'decided-paid' : 'decided-annulled',
      subjectId: settlementId,
    });
  });
}

/**
 * The settlements contested now, as {@link findSettlementOfMember} reads each (whatever the group, and whoever reads them: the
 * administrators do, see `routes/admin.ts`), the earliest contested first. It reads one consistent state of the database and
 * changes nothing.
 */
export async function contestedSettlements(db: Database): Promise<Settlement[]> {
  return inReadSnapshot(db, async snapshot => {
    const rows = await snapshot
      .prepare(
        `SELECT ${SETTLEMENT_COLUMNS} FROM settlements s
         WHERE s.status = 'contested'
         ORDER BY (SELECT MIN(h.seq) FROM settlement_statuses h WHERE h.settlement_id = s.id AND h.status = 'contested') ASC,
                  s.seq ASC`,
      )
      .all<SettlementRow>();
    const histories = new Map<string, StatusChange[]>();
    const statusRows = await snapshot
      .prepare(
        `SELECT settlement_id, status, at FROM settlement_statuses
         WHERE settlement_id IN (SELECT id FROM settlements WHERE status = 'contested') ORDER BY seq ASC`,
      )
      .all<StatusRow>();
    for (const row of statusRows) {
      const history = histories.get(row.settlement_id) ?? [];
      history.push({ status: row.status, at: row.at });
      histories.set(row.settlement_id, history);
    }
    return rows.map(row => settlementOf(row, histories.get(row.id) ?? []));
  });
}
