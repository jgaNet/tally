/**
 * Who bears the payment provider's fee on a payment of a group: its payer, its payee, or both, shared. The group's owner
 * decides it (see `fee-policy.ts`); a settlement through the provider keeps the fee the provider said and who bore it when
 * its payment was asked for.
 */
export const FEE_BEARERS = ['payer', 'payee', 'shared'] as const;
export type FeeBearer = (typeof FEE_BEARERS)[number];

/** The provider's fee on a settlement, in the minor unit of its group's currency, and who bears it. */
export interface Fee {
  readonly amount: number;
  readonly borneBy: FeeBearer;
}

/** True when `value` is one of {@link FEE_BEARERS}. */
export function isFeeBearer(value: unknown): value is FeeBearer {
  return (FEE_BEARERS as readonly unknown[]).includes(value);
}

/**
 * The part of the fee the payer bears: all of it when the payer bears it, half of it when shared (rounded down, so the
 * payee bears the extra minor unit when the fee is odd), and none when the payee bears it.
 */
export function payerPartOf(fee: Fee): number {
  switch (fee.borneBy) {
    case 'payer':
      return fee.amount;
    case 'shared':
      return Math.floor(fee.amount / 2);
    case 'payee':
      return 0;
  }
}

/**
 * What a settlement of `amount` settles: its amount less the payer's part of its fee; its whole amount when it keeps no
 * fee (a settlement asked for before fees, or one in cash or by netting). It is what the balances, the statements and the
 * audit count, while the settlement's `amount` stays the one asked for.
 */
export function settledAmount(amount: number, fee: Fee | undefined): number {
  return fee === undefined ? amount : amount - payerPartOf(fee);
}

/** A settlement's row as the database holds it: its amount and the fee it keeps, if any. */
export interface FeeColumns {
  readonly amount: number;
  readonly fee_amount: number | null;
  readonly fee_borne_by: FeeBearer | null;
}

/** The fee a settlement row keeps, `undefined` when it keeps none. */
export function feeOfRow(row: Pick<FeeColumns, 'fee_amount' | 'fee_borne_by'>): Fee | undefined {
  if (row.fee_amount === null || row.fee_borne_by === null) return undefined;
  return { amount: Number(row.fee_amount), borneBy: row.fee_borne_by };
}

/** What a settlement row settles (see {@link settledAmount}). */
export function settledOfRow(row: FeeColumns): number {
  return settledAmount(Number(row.amount), feeOfRow(row));
}

/**
 * The SQL of what the settlement of the table alias `alias` settles, exactly as {@link settledAmount} gives it: its amount
 * less the payer's part of its fee, the division of the fee rounding down. A settlement with no fee settles its amount.
 */
export function settledSql(alias: string): string {
  return `(${alias}.amount - COALESCE(CASE ${alias}.fee_borne_by
      WHEN 'payer' THEN ${alias}.fee_amount
      WHEN 'shared' THEN ${alias}.fee_amount / 2
      ELSE 0 END, 0))`;
}
