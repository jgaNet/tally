import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { ledgerBalancesReadModel } from '@Contexts/Ledger/module.local';
import { groupsMembersReadModel } from '@Contexts/Groups/module.local';
import {
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
import { SettlementsDatabase } from '@Contexts/Settlements/Infrastructure/SettlementsDatabase';
import { SqliteSettlements } from '@Contexts/Settlements/Infrastructure/SqliteSettlements';
import { SqlitePayoutAccounts } from '@Contexts/Settlements/Infrastructure/SqlitePayoutAccounts';

/**
 * The Settlements context, as data (ADR 9, ADR 10, ADR 11, ADR 12). Its settlement books and settlements are in SQLite at
 * `SETTLEMENTS_DATABASE_PATH`, or the application's database file (`DATABASE_PATH`) when that is not set, read when the first
 * request needs it. It reads the balances through a port it owns over Ledger's balances read model, and the members through one
 * over Groups' read model; both read models are given as functions, read at a request and not when the modules are built (ADR 7).
 * It asks the payment provider for a payment link through a port it owns, at `PROVIDER_URL` (read at a request, as the others).
 * Ledger reads the settlements through its own `SettledAmounts` port over `settlementsReadModel`, the one thing of this file
 * another context reaches.
 */
const database = new SettlementsDatabase(
  () => process.env.SETTLEMENTS_DATABASE_PATH || process.env.DATABASE_PATH || 'tally.sqlite',
);
export const settlementsReadModel = new SqliteSettlements(database);

const groupBalances = new GroupBalancesOfLedger(() => ledgerBalancesReadModel);
const settlementMembers = new SettlementMembersOfGroups(() => groupsMembersReadModel);
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
    receivePaymentWebhook(settlementsReadModel),
    getSettlement(settlementsReadModel, settlementMembers),
  ],
});
