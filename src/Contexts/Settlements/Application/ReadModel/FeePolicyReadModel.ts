/**
 * Who bears the provider's fee of a group's payments, as its members read it: `payer`, `payee` or `shared`, the payee until its
 * owner decides otherwise (request 38).
 */
export interface FeePolicyReadModel {
  borneBy: 'payer' | 'payee' | 'shared';
}
