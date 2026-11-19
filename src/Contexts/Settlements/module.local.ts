import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupIntegrationEvents';
import { GroupsMergedIntegrationHandler } from '@Contexts/Settlements/Application/Events/GroupsMergedIntegrationHandler';

import { groupsReadModel, ledgerReadModel } from '@Bootstrap/Fastify/readModels';
import {
  getGroupSettlements,
  getSettlement,
  recordCashSettlement,
} from '@Contexts/Settlements/Application/Settlements';
import {
  payThroughProvider,
  receivePaymentWebhook,
  refundSettlement,
} from '@Contexts/Settlements/Application/Payments';
import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Suggestions';
import { getPayoutAccount, setPayoutAccount } from '@Contexts/Settlements/Application/PayoutAccounts';
import { PostgresPayoutAccountQueries } from '@Contexts/Settlements/Infrastructure/PostgresPayoutAccountQueries';
import { PostgresPayoutAccounts } from '@Contexts/Settlements/Infrastructure/PostgresPayoutAccounts';
import { GroupBalancesOfLedger } from '@Contexts/Settlements/Infrastructure/GroupBalancesOfLedger';
import { HmacWebhookSignature } from '@Contexts/Settlements/Infrastructure/HmacWebhookSignature';
import { HttpPaymentProvider } from '@Contexts/Settlements/Infrastructure/HttpPaymentProvider';
import { SettlementMembersOfGroups } from '@Contexts/Settlements/Infrastructure/SettlementMembersOfGroups';
import { PostgresSettlementBooks } from '@Contexts/Settlements/Infrastructure/PostgresSettlementBooks';
import { PostgresSettlementQueries } from '@Contexts/Settlements/Infrastructure/PostgresSettlementQueries';
import { PostgresNettingQueries, PostgresNettings } from '@Contexts/Settlements/Infrastructure/PostgresNettings';
import { getNetting, netDebts } from '@Contexts/Settlements/Application/Nettings';
import { contestSettlement, decideContest, getContests } from '@Contexts/Settlements/Application/Contests';
import { getFeePolicy, setFeePolicy } from '@Contexts/Settlements/Application/FeePolicies';

/**
 * The Settlements context (conventions/domain.yaml, ADR 11, ADR 0012, ADR 0013, ADR 0014, ADR 0015): the settlements of each group, in cash or
 * through the payment provider, decided in its book, and the transfers that would bring the balances to 0. Its own adapters are the
 * application's PostgreSQL database: the books and the settlements, and the HTTP provider and its webhook's signature. The balances are read over Ledger's read model and the members over Groups', both opened by the composition
 * root, which keeps the modules from importing each other (docs/adr/0009); its clock is the system's, given to the use case that
 * records a time.
 */
const books = new PostgresSettlementBooks(sharedDatabase);
const settlements = new PostgresSettlementQueries(sharedDatabase);
const balances = new GroupBalancesOfLedger(ledgerReadModel);
const members = new SettlementMembersOfGroups(groupsReadModel);
const nettings = new PostgresNettings(sharedDatabase);
const nettingQueries = new PostgresNettingQueries(sharedDatabase);
const payouts = new PostgresPayoutAccounts(sharedDatabase);
const payoutQueries = new PostgresPayoutAccountQueries(sharedDatabase);
// The provider and its webhook's key are the environment's: read when they are used, not when the module loads (request 13).
const provider = new HttpPaymentProvider();
const signatures = new HmacWebhookSignature();

export const localSettlementsModule = new LiteModule({
  name: 'Settlements',
  useCases: [
    recordCashSettlement(books, balances, members, systemClock),
    payThroughProvider(books, balances, members, payouts, provider, systemClock),
    receivePaymentWebhook(books, signatures, systemClock),
    refundSettlement(books, members, provider, systemClock),
    getSettlement(settlements, members),
    getGroupSettlements(settlements, members),
    getSuggestedSettlements(balances, members, settlements),
    setPayoutAccount(payouts, provider),
    getPayoutAccount(payoutQueries),
    netDebts(books, balances, members, nettings, systemClock),
    getNetting(nettingQueries),
    contestSettlement(books, members, systemClock),
    decideContest(books, systemClock),
    getContests(settlements),
    setFeePolicy(books, members),
    getFeePolicy(settlements, members),
  ],
  integrationEvents: [
    // A merge is moved here: the group merged's settlements move to the group kept (request 31, docs/adr/0031).
    { event: GroupsMergedIntegrationEvent, handlers: [new GroupsMergedIntegrationHandler(books)] },
  ],
});
