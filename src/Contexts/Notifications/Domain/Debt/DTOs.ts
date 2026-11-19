import { CurrencyCode } from '@SharedKernel/Domain/Currency';

/**
 * What a member of a group still owes, as Settlements answers it (request 18, docs/adr/0018): `amount` is positive, in the minor units of
 * the group's `currency` (docs/adr/0039), which the reminder's threshold is read in.
 */
export interface OutstandingDebt {
  groupId: string;
  memberId: string;
  amount: number;
  currency: CurrencyCode;
}

/** A debt the sweep has noted or reminded of: the member and the group. */
export interface DebtKey {
  accountId: string;
  groupId: string;
}
