import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { ledgerBalancesReadModel } from '@Contexts/Ledger/module.local';
import { groupsMembersReadModel } from '@Contexts/Groups/module.local';
import {
  getGroupSettlements,
  getSettlement,
  getSuggestedSettlements,
  payThroughProvider,
  receivePaymentWebhook,
  recordCashSettlement,
  refundSettlement,
} from '@Contexts/Settlements/Application/Settlements';
import { GroupBalancesOfLedger } from '@Contexts/Settlements/Infrastructure/GroupBalancesOfLedger';
import { PaymentProviderOverHttp } from '@Contexts/Settlements/Infrastructure/PaymentProviderOverHttp';
import { SettlementMembersOfGroups } from '@Contexts/Settlements/Infrastructure/SettlementMembersOfGroups';
import { isSignedByProvider } from '@Contexts/Settlements/Infrastructure/ProviderSignature';
import { getPayoutAccount, setPayoutAccount } from '@Contexts/Settlements/Application/PayoutAccounts';
import { OutstandingDebtsOfBalances } from '@Contexts/Settlements/Infrastructure/OutstandingDebtsOfBalances';
import { SettlementsDatabase } from '@Contexts/Settlements/Infrastructure/SettlementsDatabase';
import { GroupsMergedIntegrationEventHandler } from '@Contexts/Settlements/Application/Events/GroupsMergedHandler';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';
import { SqliteSettlements } from '@Contexts/Settlements/Infrastructure/SqliteSettlements';
import { SqliteNettings } from '@Contexts/Settlements/Infrastructure/SqliteNettings';
import { getNetting, netDebts } from '@Contexts/Settlements/Application/Nettings';
import { SqlitePayoutAccounts } from '@Contexts/Settlements/Infrastructure/SqlitePayoutAccounts';

/**
 * The Settlements context, as data (ADR 9, ADR 10, ADR 11, ADR 12). Its settlement books and settlements are in SQLite at
 * in PostgreSQL, at `DATABASE_URL`, read when the first
 * request needs it. It reads the balances through a port it owns over Ledger's balances read model, and the members through one
 * over Groups' read model; both read models are given as functions, read at a request and not when the modules are built (ADR 7).
 * It asks the payment provider for a payment link through a port it owns, at `PROVIDER_URL` (read at a request, as the others).
 * Ledger reads the settlements through its own `SettledAmounts` port over `settlementsReadModel`, the one thing of this file
 * another context reaches.
 */
export const database = new SettlementsDatabase();
export const settlementsReadModel = new SqliteSettlements(database);
/** The nettings a netting is saved to, in the transaction of the settlements it made (request 32). */
export const nettingsStore = new SqliteNettings(database);

const groupBalances = new GroupBalancesOfLedger(() => ledgerBalancesReadModel);
const settlementMembers = new SettlementMembersOfGroups(() => groupsMembersReadModel);
/**
 * What each member still owes, the read model of the debts, which Notifications asks through its own `OutstandingDebts` port for its
 * reminders (request 18, ADR 15): the one thing of this file the reminders reach.
 */
export const outstandingDebtsReadModel = new OutstandingDebtsOfBalances(
  settlementMembers,
  groupBalances,
  settlementsReadModel,
);
const paymentProvider = new PaymentProviderOverHttp(() => process.env.PROVIDER_URL);
const payoutAccounts = new SqlitePayoutAccounts(database);

/**
 * Whether a webhook is signed by the payment provider under the secret Tally and the provider share, `PROVIDER_WEBHOOK_SECRET`, read when a
 * webhook comes (request 13). The transport asks it; it never reads the secret itself.
 */
export const providerSignedBy = (body: Buffer, header: string | undefined): boolean =>
  isSignedByProvider(body, header, process.env.PROVIDER_WEBHOOK_SECRET);

export const localSettlementsModule = new LiteModule({
  name: 'Settlements',
  useCases: [
    getSuggestedSettlements(groupBalances, settlementMembers, settlementsReadModel),
    recordCashSettlement(settlementsReadModel, groupBalances, settlementMembers, systemClock),
    setPayoutAccount(payoutAccounts, paymentProvider, systemClock),
    getPayoutAccount(payoutAccounts),
    payThroughProvider(
      settlementsReadModel,
      groupBalances,
      settlementMembers,
      payoutAccounts,
      paymentProvider,
      systemClock,
    ),
    refundSettlement(settlementsReadModel, settlementsReadModel, settlementMembers, paymentProvider, systemClock),
    receivePaymentWebhook(settlementsReadModel, systemClock),
    getSettlement(settlementsReadModel, settlementMembers),
    getGroupSettlements(settlementsReadModel, settlementMembers),
    netDebts(settlementsReadModel, groupBalances, settlementMembers, nettingsStore, systemClock),
    getNetting(settlementsReadModel),
  ],
  integrationEvents: [
    {
      event: GroupsMergedIntegrationEvent,
      handlers: [new GroupsMergedIntegrationEventHandler(settlementsReadModel)],
    },
  ],
});
