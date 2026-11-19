/**
 * Who bears the provider's fee of a group's payments through the provider (request 38): its payer, its payee, or both, shared. The group's
 * owner decides it; until they do, the payee bears it, as they did before the fee was known.
 */
export type FeeBorne = 'payer' | 'payee' | 'shared';

/** The payee bears the fee until the group's owner decides otherwise (request 38). */
export const DEFAULT_FEE_BORNE: FeeBorne = 'payee';

/**
 * The fee the provider said for a payment through it, and who bore it when the payment was asked for (request 38): a whole number of
 * hundredths of the payment's currency, which is kept out of what the provider pays the payee. Fixed at the request; changing who bears
 * the fee later changes no settlement.
 */
export interface ProviderFee {
  amount: number;
  borneBy: FeeBorne;
}

/**
 * The part of the fee the payer bears: all of it when the payer bears it, none when the payee does, and half when both share it, the
 * payer's half rounded down, so the payee bears the extra hundredth of an odd fee (request 38).
 */
export function payerPartOf(fee: ProviderFee): number {
  if (fee.borneBy === 'payer') return fee.amount;
  if (fee.borneBy === 'shared') return Math.floor(fee.amount / 2);
  return 0;
}

/**
 * What a settlement settles: its amount, less the part of the fee its payer bears (request 38). A settlement without a fee (in cash, or
 * one asked for before the fee was known) settles its amount. Its `amount` stays the one asked for.
 */
export function settledAmountOf(amount: number, fee: ProviderFee | undefined): number {
  return fee === undefined ? amount : amount - payerPartOf(fee);
}

/** Whether a value names who bears the provider's fee: one of the three, as a policy is read and set (request 38). */
export function isFeeBorne(value: string): value is FeeBorne {
  return value === 'payer' || value === 'payee' || value === 'shared';
}
