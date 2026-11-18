import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from './audit';
import { type Balance, listBalancesIncludingWaiting } from './balances';
import type { Database, Queryable } from './database';
import { findGroupOf, refuseIfArchived } from './groups';
import { isMember } from './members';
import { payoutAccountOf } from './payout-accounts';
import { Refusal } from './refusal';
import { addHistory, forgetHistory, historyOf, moveSettlement, type StatusEntry } from './settlement-history';
import {
  assertProviderConfigured,
  createProviderPayment,
  refundProviderPayment,
  type ProviderConfig,
} from './provider';
import { requireCaller } from './sessions';

/** The status of a settlement: `pending`, `paid` or `failed` for one through the provider, and `refunding` or `refunded` once paid. */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';

/** One transfer that brings a balance to 0: `from` pays `to` the `amount`. Both are members' account ids. */
export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

/**
 * The transfers that bring every balance to 0, made by this algorithm, so that every member reads the same
 * transfers:
 *  1. Start from the balances, given in the order the members joined, the earliest first.
 *  2. Take the member who owes the most (the lowest balance) and the member who is owed the most (the
 *     highest balance). Among members who owe, or are owed, the same, the one who joined first is taken.
 *  3. The first pays the second the smaller of what the first owes and what the second is owed: one
 *     transfer. Both balances move by its amount.
 *  4. Repeat from 2 until every balance is 0.
 *
 * The transfers are listed in the order they were made. Each one leaves a balance at 0, so there are never
 * more transfers than the members whose balance is not 0, less one. It only computes: the balances are not
 * changed.
 */
export function suggestSettlements(balances: Balance[]): Transfer[] {
  // The working balances, by position in the order of joining; the positions keep the tie-breaks.
  const owing = balances.map(row => ({ memberId: row.memberId, balance: row.balance }));
  const transfers: Transfer[] = [];
  for (;;) {
    // The earliest position wins a tie, because the comparison is strict.
    let debtor = -1;
    let creditor = -1;
    owing.forEach((row, position) => {
      if (row.balance < 0 && (debtor === -1 || row.balance < owing[debtor].balance)) debtor = position;
      if (row.balance > 0 && (creditor === -1 || row.balance > owing[creditor].balance)) creditor = position;
    });
    if (debtor === -1 || creditor === -1) return transfers;
    const amount = Math.min(-owing[debtor].balance, owing[creditor].balance);
    owing[debtor].balance += amount;
    owing[creditor].balance -= amount;
    transfers.push({ from: owing[debtor].memberId, to: owing[creditor].memberId, amount });
  }
}

/**
 * A settlement as it is read: the payer `from` pays the payee `to` the `amount`, when it was recorded at `at`.
 * A cash settlement is paid from the moment it is recorded. One through the provider is `pending` until the
 * provider decides it: `paid` once it succeeded, `failed` once it did not; `payUrl` is the link where the
 * payer pays it. A paid one is `refunding` while the provider is asked to refund it, and `refunded` once the
 * provider says the payment is refunded.
 */
export interface Settlement {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash' | 'provider';
  status: SettlementStatus;
  at: string;
  payUrl?: string;
  /** Every status the settlement has had, the earliest first, each with the moment Tally learned it. */
  history: StatusEntry[];
}

/** What the payee records: the payer's account id, and the amount in hundredths of the group's currency. */
export interface NewCashSettlement {
  from: string;
  amount: number;
}

/** What the payer asks: the payee's account id, and the amount in hundredths of the group's currency. */
export interface NewProviderSettlement {
  to: string;
  amount: number;
}

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: 'cash' | 'provider';
  status: SettlementStatus;
  pay_url: string | null;
  created_at: string;
}

/** A refusal of a rule that is about the settlement, not about the shape of the request. */
function refuse(statusCode: number, type: string, message: string): never {
  throw new Refusal(statusCode, type, message);
}

/** The amount of a settlement is a whole number, at least 1. */
function checkWholeAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount < 1) {
    refuse(422, 'InvalidAmount', 'The amount of a settlement is a whole number, at least 1.');
  }
}

/** The rule every settlement shares: never more than the payer owes, nor than the payee is owed. */
async function checkLimits(
  db: Queryable,
  groupId: string,
  payerId: string,
  payeeId: string,
  amount: number,
): Promise<void> {
  // What is still owed counts the payments waiting at the provider as paid.
  const balances = await listBalancesIncludingWaiting(db, groupId);
  const payerBalance = balances.find(row => row.memberId === payerId)?.balance ?? 0;
  const payeeBalance = balances.find(row => row.memberId === payeeId)?.balance ?? 0;
  if (amount > -payerBalance) refuse(409, 'AmountTooLarge', 'The payer does not owe the group that much.');
  if (amount > payeeBalance) refuse(409, 'AmountTooLarge', 'The payee is not owed that much by the group.');
}

/**
 * Records that the payer `from` paid the account, the payee, the amount in cash, and returns its id. The
 * payee is the account that records it, and must be a member of the group; for anyone else the group does
 * not exist. The payer must be another member of the group.
 *
 * The amount is at least 1, and never more than the payer owes the group (the opposite of their balance)
 * nor more than the payee is owed (their balance), on the balances as they are at the moment, with the
 * payments waiting at the provider counted as paid. Otherwise it is refused and nothing is written. The
 * balances are read and the settlement written in one write transaction, which waits for the write lock,
 * so two settlements recorded at once are decided one after the other, each on the balances the other left.
 */
export async function recordCashSettlement(
  db: Database,
  payeeId: string,
  groupId: string,
  input: NewCashSettlement,
): Promise<string> {
  const id = randomUUID();
  await db.transaction(async tx => {
    if (!(await findGroupOf(tx, payeeId, groupId))) throw new Refusal(404, 'NotFound', 'There is no such group.');
    await refuseIfArchived(tx, groupId);
    checkWholeAmount(input.amount);
    if (input.from === payeeId || !(await isMember(tx, groupId, input.from))) {
      refuse(422, 'InvalidPayer', 'The payer must be another member of the group.');
    }
    await checkLimits(tx, groupId, input.from, payeeId, input.amount);
    const at = new Date().toISOString();
    await tx.run(
      `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'cash', 'paid', ?)`,
      [id, groupId, input.from, payeeId, input.amount, at],
    );
    await addHistory(tx, id, 'paid', at);
    await writeAudit(tx, groupId, { by: payeeId, action: 'settlement-paid', subjectId: id, amount: input.amount, at });
  });
  return id;
}

/**
 * Starts a settlement through the payment provider: the payer `payerId` asks to pay the payee `to` the amount.
 * It is checked as a cash settlement is (the payer is the caller, and the payee another member), and the payee must
 * have a payout account at the provider, `PayoutAccountRequired` otherwise. The settlement is kept `pending`,
 * without a payment yet, in the same write transaction, so that the amount is held while the provider is asked.
 * Answers its id and the group's currency; the provider is asked after this, outside the transaction, which is why
 * the caller must finish the settlement with `attachPayment` or `releaseSettlement`.
 */
export async function reserveProviderSettlement(
  db: Database,
  payerId: string,
  groupId: string,
  input: NewProviderSettlement,
): Promise<{ id: string; currency: string }> {
  const id = randomUUID();
  let currency = '';
  await db.transaction(async tx => {
    const group = await findGroupOf(tx, payerId, groupId);
    if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
    await refuseIfArchived(tx, groupId);
    currency = group.currency;
    checkWholeAmount(input.amount);
    if (input.to === payerId || !(await isMember(tx, groupId, input.to))) {
      refuse(422, 'InvalidPayee', 'The payee must be another member of the group.');
    }
    if ((await payoutAccountOf(tx, input.to)) === undefined) {
      refuse(409, 'PayoutAccountRequired', 'The payee has no payout account at the payment provider.');
    }
    await checkLimits(tx, groupId, payerId, input.to, input.amount);
    const at = new Date().toISOString();
    await tx.run(
      `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'provider', 'pending', ?)`,
      [id, groupId, payerId, input.to, input.amount, at],
    );
    await addHistory(tx, id, 'pending', at);
  });
  return { id, currency };
}

/**
 * Keeps the provider's payment and its link on the settlement that asked for it. A decision on the payment that
 * came before this answer (a webhook may overtake it) is applied at once, so the settlement is not left pending.
 */
export async function attachPayment(
  db: Database,
  settlementId: string,
  payment: { id: string; payUrl: string },
): Promise<void> {
  await db.transaction(async tx => {
    await tx.run('UPDATE settlements SET provider_id = ?, pay_url = ? WHERE id = ?', [
      payment.id,
      payment.payUrl,
      settlementId,
    ]);
    await applyKeptDecision(tx, payment.id);
  });
}

/** Drops a settlement that asked the provider for nothing: the provider did not answer, so nothing is kept. */
export async function releaseSettlement(db: Database, settlementId: string): Promise<void> {
  await db.transaction(async tx => {
    const releasable = await tx.get(
      "SELECT 1 FROM settlements WHERE id = ? AND method = 'provider' AND status = 'pending' AND provider_id IS NULL",
      [settlementId],
    );
    if (releasable === undefined) return;
    await forgetHistory(tx, settlementId);
    await tx.run('DELETE FROM settlements WHERE id = ?', [settlementId]);
  });
}

/** The decision a webhook's status makes on a payment, or `undefined` for a status that decides nothing. */
function decisionOf(status: string): PaymentDecision | undefined {
  if (status === 'succeeded') return 'paid';
  if (status === 'failed') return 'failed';
  if (status === 'refunded') return 'refunded';
  return undefined;
}

/** A decision the provider made on a payment, as Tally keeps it: `paid` (it succeeded), `failed`, or `refunded`. */
type PaymentDecision = 'paid' | 'failed' | 'refunded';

/**
 * Applies the provider's decision on a payment: `succeeded` makes it `paid`, `failed` makes it `failed`, and
 * `refunded` makes it `refunded`. A payment moves forward once: the first decision it receives is kept with it,
 * and applied to its settlement, if the settlement is still waiting for it. A decision that comes again changes
 * nothing, and so does a contrary one after the first, with one exception: a payment that succeeded may later be
 * refunded, so a `refunded` after a `paid` moves it on, and it ends there. Whatever comes after a `refunded`
 * changes nothing, and so does a `refunded` after a `failed`. A `refunded` that arrives before the `succeeded` of
 * the same payment is kept as it is, so the settlement is `refunded`, never counted. `pending` and any other
 * status change nothing. A decision for a payment Tally has not yet been answered for is kept, and applied when
 * its answer is kept.
 *
 * It is one write transaction, so two servers on the same database that receive the decision at once keep
 * the first one, and the settlement changes once.
 */
export async function applyPaymentDecision(db: Database, paymentId: string, status: string): Promise<void> {
  const decided = decisionOf(status);
  if (decided === undefined) return;
  await db.transaction(async tx => {
    // The moment Tally learns the decision: the status it makes a settlement take is dated by it.
    const at = new Date().toISOString();
    const kept = await keptDecision(tx, paymentId);
    if (kept === undefined) {
      await tx.run('INSERT INTO payment_decisions (payment_id, status, decided_at) VALUES (?, ?, ?)', [
        paymentId,
        decided,
        at,
      ]);
    } else if (kept.status === 'paid' && decided === 'refunded') {
      await tx.run("UPDATE payment_decisions SET status = 'refunded', decided_at = ? WHERE payment_id = ?", [
        at,
        paymentId,
      ]);
    }
    await applyKeptDecision(tx, paymentId);
  });
}

/** The decision kept for the payment, and the moment Tally learned it, if Tally has one. */
async function keptDecision(
  db: Queryable,
  paymentId: string,
): Promise<{ status: PaymentDecision; decidedAt: string } | undefined> {
  const kept = await db.get<{ status: PaymentDecision; decided_at: string }>(
    'SELECT status, decided_at FROM payment_decisions WHERE payment_id = ?',
    [paymentId],
  );
  return kept && { status: kept.status, decidedAt: kept.decided_at };
}

/**
 * Makes the settlement of the payment as its kept decision says: `paid` or `failed` while it is pending, and
 * `refunded` while it is pending, paid or being refunded. Each settlement it moves gets the entry in its history
 * dated by the moment the decision was learned; a settlement it does not move gets none.
 */
async function applyKeptDecision(db: Queryable, paymentId: string): Promise<void> {
  const kept = await keptDecision(db, paymentId);
  if (kept === undefined) return;
  const from: SettlementStatus[] = kept.status === 'refunded' ? ['pending', 'paid', 'refunding'] : ['pending'];
  const waiting = await db.all<{ id: string }>(
    `SELECT id FROM settlements WHERE provider_id = ? AND method = 'provider' AND status IN (${from.map(() => '?').join(', ')})`,
    [paymentId, ...from],
  );
  for (const settlement of waiting) await moveSettlement(db, settlement.id, kept.status, kept.decidedAt);
}

/**
 * Whether a settlement waits at the provider for the account, as its payer or as its payee, in the group: one
 * whose payment is still pending, or whose refund the provider has not yet said is done. Either would move the
 * account's balance once the provider decides it.
 */
export async function hasWaitingSettlement(db: Queryable, groupId: string, accountId: string): Promise<boolean> {
  const row = await db.get(
    "SELECT 1 FROM settlements WHERE group_id = ? AND status IN ('pending', 'refunding') AND (payer_id = ? OR payee_id = ?)",
    [groupId, accountId, accountId],
  );
  return row !== undefined;
}

const settlementColumns =
  't.id, t.group_id, t.payer_id, t.payee_id, t.amount, t.method, t.status, t.pay_url, t.created_at';

/** The settlement as it is read, with its history. */
async function toSettlement(db: Queryable, row: SettlementRow): Promise<Settlement> {
  const settlement: Settlement = {
    id: row.id,
    groupId: row.group_id,
    from: row.payer_id,
    to: row.payee_id,
    amount: row.amount,
    method: row.method,
    status: row.status,
    at: row.created_at,
    history: await historyOf(db, row.id),
  };
  if (row.method === 'provider' && row.pay_url !== null) settlement.payUrl = row.pay_url;
  return settlement;
}

/** The settlement, when the account is a member of its group. For anyone else it does not exist. */
export async function findSettlementOf(
  db: Queryable,
  accountId: string,
  settlementId: string,
): Promise<Settlement | undefined> {
  const row = await db.get<SettlementRow>(
    `SELECT ${settlementColumns} FROM settlements t JOIN group_members m ON m.group_id = t.group_id
     WHERE t.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    [settlementId, accountId],
  );
  return row && toSettlement(db, row);
}

/**
 * The settlements of the group, the most recently recorded first, each as `findSettlementOf` reads it. They are
 * listed for a member of the group, and they include those of a member who has left it, as they are the group's.
 */
export async function listSettlementsOf(db: Queryable, groupId: string): Promise<Settlement[]> {
  const rows = await db.all<SettlementRow>(
    `SELECT ${settlementColumns} FROM settlements t
     WHERE t.group_id = ? ORDER BY t.created_at DESC, t.seq DESC`,
    [groupId],
  );
  const settlements: Settlement[] = [];
  for (const row of rows) settlements.push(await toSettlement(db, row));
  return settlements;
}

/**
 * Refunds a settlement paid through the provider, whole: the payee `payeeId` asks the provider to refund its
 * payment, with the settlement's id as the reference. The settlement is `refunding` until the provider says the
 * payment is refunded, by its webhook, and it is still counted as paid meanwhile.
 *
 * Only the payee may refund, and only a `paid` settlement: a cash settlement is not refunded through Tally, and nor
 * is one whose payer or payee is no longer a member of the group, so that the balances still add up to 0. For an
 * account that is not a member of the group the settlement does not exist; for a member who is not its payee the
 * refund is refused with `NotAllowed`. Anything else is refused, and nothing changes.
 *
 * The checks and the `refunding` are one write transaction, so two refunds asked at once are decided one after the
 * other: the second finds the settlement already refunding. The provider is asked after that transaction. When it
 * does not answer `201` with an `id`, or not in time, the settlement goes back to `paid`, and the refusal is answered.
 */
export async function refundSettlement(
  db: Database,
  provider: ProviderConfig,
  payeeId: string,
  settlementId: string,
): Promise<void> {
  const reserved = await db.transaction(async tx => {
    const settlement = await findSettlementOf(tx, payeeId, settlementId);
    if (!settlement) throw new Refusal(404, 'NotFound', 'There is no such settlement.');
    await refuseIfArchived(tx, settlement.groupId);
    if (settlement.to !== payeeId) refuse(403, 'NotAllowed', 'Only the payee of the settlement may refund it.');
    if (settlement.method !== 'provider') {
      refuse(409, 'NotRefundable', 'Only a settlement paid through the payment provider is refunded.');
    }
    if (settlement.status !== 'paid') refuse(409, 'NotRefundable', 'Only a paid settlement is refunded.');
    if (
      !(await isMember(tx, settlement.groupId, settlement.from)) ||
      !(await isMember(tx, settlement.groupId, settlement.to))
    ) {
      refuse(409, 'NotRefundable', 'The payer and the payee of the settlement must both be members of the group.');
    }
    assertProviderConfigured(provider);
    const row = await tx.get<{ provider_id: string | null }>('SELECT provider_id FROM settlements WHERE id = ?', [
      settlementId,
    ]);
    if (!row || row.provider_id === null) {
      refuse(409, 'NotRefundable', 'The provider does not know the payment of this settlement.');
    }
    await moveSettlement(tx, settlementId, 'refunding', new Date().toISOString());
    return { paymentId: row.provider_id, provider };
  });
  try {
    await refundProviderPayment(reserved.provider, { paymentId: reserved.paymentId, reference: settlementId });
  } catch (error) {
    await releaseRefund(db, settlementId);
    throw error;
  }
}

/** Puts back a settlement whose refund the provider did not take: `refunding` becomes `paid`, and nothing else moves. */
async function releaseRefund(db: Database, settlementId: string): Promise<void> {
  await db.transaction(async tx => {
    const row = await tx.get<{ status: SettlementStatus }>('SELECT status FROM settlements WHERE id = ?', [
      settlementId,
    ]);
    if (row?.status === 'refunding') await moveSettlement(tx, settlementId, 'paid', new Date().toISOString());
  });
}

const transferSchema = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'integer' } },
};

const idSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
};

const settlementSchema = {
  type: 'object',
  required: ['id', 'groupId', 'from', 'to', 'amount', 'method', 'status', 'at', 'history'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer', minimum: 1 },
    method: { enum: ['cash', 'provider'] },
    status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded'] },
    at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
    payUrl: { type: 'string', minLength: 1 },
    history: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['status', 'at'],
        properties: {
          status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded'] },
          at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
        },
      },
    },
  },
};

/**
 * The suggested settlements are read by the members of the group. For anyone else the group does not exist.
 * A read changes nothing: the transfers are computed from the balances as the expenses and settlements make
 * them now, the payments waiting at the provider counted as paid.
 *
 * A cash settlement is recorded by its payee, a member of the group; a settlement through the provider is
 * asked for by its payer. A settlement is read by the members of its group; for anyone else it does not exist.
 */
export function registerSettlementRoutes(app: FastifyInstance, db: Database, provider: ProviderConfig): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/settlements/suggested',
    { schema: { response: { 200: { type: 'array', items: transferSchema } } } },
    async request => {
      const accountId = await requireCaller(db, request);
      if (!(await findGroupOf(db, accountId, request.params.id))) {
        throw new Refusal(404, 'NotFound', 'There is no such group.');
      }
      return suggestSettlements(await listBalancesIncludingWaiting(db, request.params.id));
    },
  );

  app.post<{ Params: { id: string }; Body: NewCashSettlement }>(
    '/groups/:id/settlements/cash',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from', 'amount'],
          properties: { from: { type: 'string' }, amount: { type: 'integer' } },
        },
        response: { 201: idSchema },
      },
    },
    async (request, reply) => {
      const accountId = await requireCaller(db, request);
      return reply.code(201).send({ id: await recordCashSettlement(db, accountId, request.params.id, request.body) });
    },
  );

  app.post<{ Params: { id: string }; Body: NewProviderSettlement }>(
    '/groups/:id/settlements/provider',
    {
      schema: {
        body: {
          type: 'object',
          required: ['to', 'amount'],
          properties: { to: { type: 'string' }, amount: { type: 'integer' } },
        },
        response: { 201: idSchema },
      },
    },
    async (request, reply) => {
      const accountId = await requireCaller(db, request);
      assertProviderConfigured(provider);
      const { id, currency } = await reserveProviderSettlement(db, accountId, request.params.id, request.body);
      try {
        // The payee's payout account as it is at the moment the provider is asked.
        const payee = await payoutAccountOf(db, request.body.to);
        if (payee === undefined) {
          refuse(409, 'PayoutAccountRequired', 'The payee has no payout account at the payment provider.');
        }
        const payment = await createProviderPayment(provider, {
          reference: id,
          amount: request.body.amount,
          currency,
          payee,
        });
        await attachPayment(db, id, payment);
      } catch (error) {
        await releaseSettlement(db, id);
        throw error;
      }
      return reply.code(201).send({ id });
    },
  );

  app.post<{ Params: { id: string } }>('/settlements/:id/refund', async (request, reply) => {
    const accountId = await requireCaller(db, request);
    await refundSettlement(db, provider, accountId, request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>(
    '/groups/:id/settlements',
    { schema: { response: { 200: { type: 'array', items: settlementSchema } } } },
    async request => {
      const accountId = await requireCaller(db, request);
      if (!(await findGroupOf(db, accountId, request.params.id))) {
        throw new Refusal(404, 'NotFound', 'There is no such group.');
      }
      return listSettlementsOf(db, request.params.id);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/settlements/:id',
    { schema: { response: { 200: settlementSchema } } },
    async request => {
      const accountId = await requireCaller(db, request);
      const settlement = await findSettlementOf(db, accountId, request.params.id);
      if (!settlement) throw new Refusal(404, 'NotFound', 'There is no such settlement.');
      return settlement;
    },
  );
}
