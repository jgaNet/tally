import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { groupsReadModel, ledgerReadModel } from '@Bootstrap/Fastify/readModels';
import { getSettlement, recordCashSettlement } from '@Contexts/Settlements/Application/Settlements';
import { payThroughProvider, receivePaymentWebhook } from '@Contexts/Settlements/Application/Payments';
import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Suggestions';
import { GroupBalancesOfLedger } from '@Contexts/Settlements/Infrastructure/GroupBalancesOfLedger';
import { HmacWebhookSignature } from '@Contexts/Settlements/Infrastructure/HmacWebhookSignature';
import { HttpPaymentProvider } from '@Contexts/Settlements/Infrastructure/HttpPaymentProvider';
import { SettlementMembersOfGroups } from '@Contexts/Settlements/Infrastructure/SettlementMembersOfGroups';
import { SqliteSettlementBooks } from '@Contexts/Settlements/Infrastructure/SqliteSettlementBooks';
import { SqliteSettlementQueries } from '@Contexts/Settlements/Infrastructure/SqliteSettlementQueries';

/**
 * The Settlements context (conventions/domain.yaml, ADR 11, ADR 0012, ADR 0013, ADR 0014): the settlements of each group, in cash or
 * through the payment provider, decided in its book, and the transfers that would bring the balances to 0. Its own adapters are the
 * application's SQLite file: the books and the settlements, and the HTTP provider and its webhook's signature. The balances are read over Ledger's read model and the members over Groups', both opened by the composition
 * root, which keeps the modules from importing each other (docs/adr/0009); its clock is the system's, given to the use case that
 * records a time.
 */
const books = new SqliteSettlementBooks(sharedDatabase);
const settlements = new SqliteSettlementQueries(sharedDatabase);
const balances = new GroupBalancesOfLedger(ledgerReadModel);
const members = new SettlementMembersOfGroups(groupsReadModel);
// The provider and its webhook's key are the environment's: read when they are used, not when the module loads (request 13).
const provider = new HttpPaymentProvider();
const signatures = new HmacWebhookSignature();

export const localSettlementsModule = new LiteModule({
  name: 'Settlements',
  useCases: [
    recordCashSettlement(books, balances, members, systemClock),
    payThroughProvider(books, balances, members, provider, systemClock),
    receivePaymentWebhook(books, signatures),
    getSettlement(settlements, members),
    getSuggestedSettlements(balances, members, settlements),
  ],
});
