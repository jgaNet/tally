/**
 * Who bears the provider's fee on a group's payments (request 38, docs/adr/0037): the payer, the payee, or both, shared. The owner of the
 * group decides it; until then the payee bears it, as it did before request 38.
 */
export const FEE_BORNE = ['payer', 'payee', 'shared'] as const;

export type FeeBorne = (typeof FEE_BORNE)[number];

/** Who bears the fee until the owner decides (request 38): the payee, as before the fee was known. */
export const DEFAULT_FEE_BORNE: FeeBorne = 'payee';

export const isFeeBorne = (value: unknown): value is FeeBorne => (FEE_BORNE as readonly unknown[]).includes(value);

/** What a settlement through the provider keeps of the provider's fee, asked for once: who bore it, and its amount (request 38). */
export interface SettlementFee {
  /** The fee the provider said, in the hundredths of the payment's currency. */
  amount: number;
  borneBy: FeeBorne;
}

/**
 * The part of the provider's fee its payer bears: all of it when the payer bears it, none when the payee does, and half of it when both
 * share it, rounded down: the payee bears the extra hundredth when the fee is odd (request 38).
 */
export function payerShareOfFee(fee: number, borneBy: FeeBorne): number {
  switch (borneBy) {
    case 'payer':
      return fee;
    case 'payee':
      return 0;
    case 'shared':
      return Math.floor(fee / 2);
  }
}

/**
 * What a settlement through the provider settles: its amount less the part of the fee its payer bears (request 38). Its amount stays the
 * one asked for; this is what the balances, the statements and the audit count.
 */
export function settledAmountOf({ amount, fee, borneBy }: { amount: number; fee: number; borneBy: FeeBorne }): number {
  return amount - payerShareOfFee(fee, borneBy);
}
