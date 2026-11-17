import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Suggestions';
import {
  getGroupSettlements,
  getSettlement,
  payThroughProvider,
  receivePaymentWebhook,
  recordCashSettlement,
  refundSettlement,
} from '@Contexts/Settlements/Application/Settlements';
import { getPayoutAccount, setPayoutAccount } from '@Contexts/Settlements/Application/PayoutAccounts';
import { ISettlementRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementRoster';
import { IWaitingPaymentRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingPaymentRoster';
import { SqliteWaitingPaymentRoster } from '@Contexts/Settlements/Infrastructure/SqliteWaitingPaymentRoster';
import { BalanceRoster, BalancesFromLedger } from '@Contexts/Settlements/Infrastructure/BalancesFromLedger';
import { GroupRoster, MembersFromGroups } from '@Contexts/Settlements/Infrastructure/MembersFromGroups';
import { HttpPaymentProvider } from '@Contexts/Settlements/Infrastructure/HttpPaymentProvider';
import { HmacWebhookSignature } from '@Contexts/Settlements/Infrastructure/HmacWebhookSignature';
import { SqliteSettlementRoster } from '@Contexts/Settlements/Infrastructure/SqliteSettlementRoster';
import { OutstandingDebtRoster } from '@Contexts/Settlements/Infrastructure/OutstandingDebtRoster';
import { IDebtRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/IDebtRoster';
import {
  SqliteSettlementStore,
  settlementsTablesSchema,
} from '@Contexts/Settlements/Infrastructure/SqliteSettlementStore';
import {
  SqlitePayoutAccountStore,
  payoutAccountsTablesSchema,
} from '@Contexts/Settlements/Infrastructure/SqlitePayoutAccountStore';

/**
 * The Settlements context (conventions/domain.yaml, ADRs 8, 9 and 10): its wiring, as data. Its tables are opened by the composition
 * root with `settlementsSchema`, after the groups' (they name a group). The suggested settlements (request 11) read the members of a
 * group through `roster`, Groups' read model, and the balances through `balances`, Ledger's read model; a cash settlement (request 12)
 * is decided in the group's book, read the same way and kept in this context's own tables. A payment through the provider (request 13)
 * is asked of the payment provider, configured by `payments` (PROVIDER_URL, PROVIDER_WEBHOOK_SECRET), and its webhook is checked with
 * the same secret. A person's payout account at the provider (request 16, ADR 11) is set and read by the caller, and a payment to a
 * member is refused without one. This file imports no other context. The module lists each use case once.
 */
export const settlementsSchema = [...settlementsTablesSchema, ...payoutAccountsTablesSchema];

/** What the payment provider needs of the environment: its API's base URL, and the secret its webhooks are signed with. */
export interface PaymentsConfig {
  /** The base of the provider's API, without a trailing slash (PROVIDER_URL). Without it, paying through the provider is refused. */
  readonly providerUrl?: string;
  /** The secret Tally and the provider share, for the webhooks' signature (PROVIDER_WEBHOOK_SECRET). */
  readonly webhookSecret?: string;
}

/**
 * What the settlements of a group do to its members' balances, as Settlements' read model gives it to Ledger (ADR 10). It is over the
 * database alone, so the composition root can build it before Ledger's own wiring, which counts it.
 */
export function settlementRoster(database: SqliteDatabase): ISettlementRoster {
  return new SqliteSettlementRoster(database);
}

/**
 * The payments waiting at the provider, as Settlements' read model gives them to Groups (request 20, ADR 15): a member with one cannot
 * leave its group. Built over the database alone, so the composition root can give it to Groups before Groups' own wiring.
 */
export function waitingPaymentRoster(database: SqliteDatabase): IWaitingPaymentRoster {
  return new SqliteWaitingPaymentRoster(database);
}

/**
 * What every member of every group still owes, as Settlements' read model gives it to Notifications' sweep (feature 18, ADR 14): the
 * payments waiting at the provider counted as paid, and the current members only. Built over the database, Groups' roster and Ledger's
 * balances, so the composition root can build it with the other read models.
 */
export function outstandingDebtRoster(
  database: SqliteDatabase,
  roster: GroupRoster,
  balances: BalanceRoster,
): IDebtRoster {
  return new OutstandingDebtRoster(database, roster, balances);
}

export function settlementsWiring(
  database: SqliteDatabase,
  roster: GroupRoster,
  balances: BalanceRoster,
  payments: PaymentsConfig = {},
): LiteModule {
  const store = new SqliteSettlementStore(database);
  const payouts = new SqlitePayoutAccountStore(database);
  const members = new MembersFromGroups(roster);
  const counted = new BalancesFromLedger(balances);
  const provider = new HttpPaymentProvider(payments.providerUrl);

  return new LiteModule({
    name: 'Settlements',
    useCases: [
      getSuggestedSettlements(store, members, counted),
      recordCashSettlement(store, members, counted, systemClock),
      payThroughProvider(store, members, counted, payouts, provider, systemClock),
      receivePaymentWebhook(store, members, counted, new HmacWebhookSignature(payments.webhookSecret), systemClock),
      refundSettlement(store, members, counted, provider, systemClock),
      getGroupSettlements(store, members),
      getSettlement(store, members),
      setPayoutAccount(payouts, provider, systemClock),
      getPayoutAccount(payouts),
    ],
  });
}
