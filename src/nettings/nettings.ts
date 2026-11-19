import { randomUUID } from 'node:crypto';
import { isDeleted } from '../accounts/accounts';
import { requireNotSuspended } from '../admin/suspensions';
import { recordAudit } from '../audit/audit';
import { balancesWithPendingOf } from '../balances/balances';
import { type Database, inTransaction } from '../database';
import { CURRENCIES, type Currency } from '../groups/validation';
import { Refusal } from '../refusal';
import { recordStatus } from '../settlements/history';

/** A netting as the API answers it: what two members owe each other, netted as settlements. */
export interface Netting {
  id: string;
  /** The account id of the member who asked. */
  by: string;
  /** The account id of the other member. */
  with: string;
  currency: Currency;
  /** What was netted, in the minor unit of `currency`. */
  amount: number;
  /** The settlements made, in the order they were made. */
  settlements: string[];
}

/** What one group lets each of the two members pay the other, in the minor unit of the group's currency. */
interface GroupShare {
  groupId: string;
  /** What the caller can pay the other member in this group. */
  byCanPay: number;
  /** What the other member can pay the caller in this group. */
  withCanPay: number;
}

/** A settlement to make: `payer` pays `payee` `amount` in `groupId`. */
interface Planned {
  groupId: string;
  payerId: string;
  payeeId: string;
  amount: number;
}

/**
 * Nets what `byId` and `withId` owe each other in `currency`, across the groups they are both members of now, that
 * are in `currency` and not archived, and answers its id. The amount netted is the smaller of what `byId` can pay
 * `withId` across the groups and what `withId` can pay `byId`. Each side pays, group by group in the order the groups
 * were created, the smaller of what is left to net and what the payer can pay there; a payment waiting at the provider
 * counts as paid. A netting makes all its settlements or none: they are written in one transaction under the write
 * lock, after the balances are read, so a netting or a settlement made at the same moment is decided on what the
 * other left.
 *
 * A suspended `byId` is refused with `AccountSuspended` before anything else. It is refused with `422` when `withId`
 * is the caller or `currency` is not one of Tally's, and with `409` when `withId` is a deleted account
 * (`AccountDeleted`) or when nothing can be netted, in which case nothing changes. Each settlement is `net`, `paid` at
 * once, and audited as a `settlement-paid` by `byId`; it is never refunded.
 */
export function netAcross(db: Database, byId: string, withId: string, currency: string): Promise<string> {
  return inTransaction(db, async () => {
    await requireNotSuspended(db, byId);
    if (withId === byId) {
      throw new Refusal(422, 'NettingWithSelf', 'A netting is between two members, not one with oneself.');
    }
    if (!(CURRENCIES as readonly string[]).includes(currency)) {
      throw new Refusal(422, 'InvalidCurrency', `The currency must be one of ${CURRENCIES.join(', ')}.`);
    }
    if (await isDeleted(db, withId)) {
      throw new Refusal(
        409,
        'AccountDeleted',
        'The other member has deleted their account: nothing is netted with it.',
      );
    }
    const shares = await sharesAcross(db, byId, withId, currency as Currency);
    const byTotal = sum(shares.map(share => share.byCanPay));
    const withTotal = sum(shares.map(share => share.withCanPay));
    const amount = Math.min(byTotal, withTotal);
    if (amount === 0) {
      throw new Refusal(409, 'NothingToNet', 'There is nothing to net between the two members in this currency.');
    }

    const planned = [
      ...allocate(shares, amount, byId, withId, share => share.byCanPay),
      ...allocate(shares, amount, withId, byId, share => share.withCanPay),
    ];
    const at = new Date().toISOString();
    const settlements: string[] = [];
    for (const payment of planned) {
      const id = randomUUID();
      await db.execute(
        `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'net', 'paid', ?)`,
        [id, payment.groupId, payment.payerId, payment.payeeId, payment.amount, at],
      );
      await recordStatus(db, id, 'paid', at);
      await recordAudit(
        db,
        payment.groupId,
        { by: byId, action: 'settlement-paid', subjectId: id, amount: payment.amount },
        at,
      );
      settlements.push(id);
    }

    const id = randomUUID();
    await db.execute(
      'INSERT INTO nettings (id, by_id, with_id, currency, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, byId, withId, currency, amount, at],
    );
    for (const [position, settlementId] of settlements.entries()) {
      await db.execute('INSERT INTO netting_settlements (netting_id, position, settlement_id) VALUES (?, ?, ?)', [
        id,
        position,
        settlementId,
      ]);
    }
    return id;
  });
}

/**
 * What each group of `byId` and `withId` lets each pay the other, in the order the groups were created. Only the groups
 * both are members of now, in `currency`, and not archived. Reads the balances as they are: changes nothing.
 */
async function sharesAcross(db: Database, byId: string, withId: string, currency: Currency): Promise<GroupShare[]> {
  const groups = await db.rows<{ id: string }>(
    `SELECT groups.id FROM groups
       JOIN memberships AS mine ON mine.group_id = groups.id AND mine.account_id = ?
       JOIN memberships AS theirs ON theirs.group_id = groups.id AND theirs.account_id = ?
      WHERE groups.currency = ? AND groups.archived_at IS NULL
      ORDER BY groups.created_at, groups.seq`,
    [byId, withId, currency],
  );
  const shares: GroupShare[] = [];
  for (const group of groups) {
    const balances = await balancesWithPendingOf(db, group.id);
    const by = balances.find(entry => entry.memberId === byId)?.balance ?? 0;
    const withBalance = balances.find(entry => entry.memberId === withId)?.balance ?? 0;
    shares.push({
      groupId: group.id,
      byCanPay: by < 0 && withBalance > 0 ? Math.min(-by, withBalance) : 0,
      withCanPay: withBalance < 0 && by > 0 ? Math.min(-withBalance, by) : 0,
    });
  }
  return shares;
}

/** The payments of `payerId` to `payeeId` that make up `amount`, group by group, each the smaller of what is left and what the payer can pay there. */
function allocate(
  shares: GroupShare[],
  amount: number,
  payerId: string,
  payeeId: string,
  canPay: (share: GroupShare) => number,
): Planned[] {
  let left = amount;
  const planned: Planned[] = [];
  for (const share of shares) {
    const pay = Math.min(left, canPay(share));
    if (pay > 0) {
      planned.push({ groupId: share.groupId, payerId, payeeId, amount: pay });
      left -= pay;
    }
  }
  return planned;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

interface NettingRow {
  id: string;
  by_id: string;
  with_id: string;
  currency: Currency;
  amount: number;
}

/**
 * The netting `nettingId`, for one of the two members it is between. For anyone else it is `undefined`, the same as a
 * netting that does not exist. Reading it changes nothing.
 */
export async function findNetting(db: Database, nettingId: string, accountId: string): Promise<Netting | undefined> {
  const row = await db.row<NettingRow>(
    `SELECT id, by_id, with_id, currency, amount FROM nettings
      WHERE id = ? AND (by_id = ? OR with_id = ?)`,
    [nettingId, accountId, accountId],
  );
  if (row === undefined) {
    return undefined;
  }
  const settlements = await db.rows<{ settlement_id: string }>(
    'SELECT settlement_id FROM netting_settlements WHERE netting_id = ? ORDER BY position',
    [nettingId],
  );
  return {
    id: row.id,
    by: row.by_id,
    with: row.with_id,
    currency: row.currency,
    amount: Number(row.amount),
    settlements: settlements.map(entry => entry.settlement_id),
  };
}
