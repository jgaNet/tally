import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';

import { ledgerBalanceQueries } from '@Bootstrap/Fastify/readModels';
import { groupQueries } from '@Contexts/Groups/module.local';
import {
  GetPayoutAccountQueryHandler,
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';
import {
  PayThroughProviderCommandEvent,
  PayThroughProviderCommandHandler,
  ReceivePaymentWebhookCommandEvent,
  ReceivePaymentWebhookCommandHandler,
  RecordCashSettlementCommandEvent,
  RecordCashSettlementCommandHandler,
  RefundSettlementCommandEvent,
  RefundSettlementCommandHandler,
  SetPayoutAccountCommandEvent,
  SetPayoutAccountCommandHandler,
} from '@Contexts/Settlements/Application/Commands';
import { LedgerGroupBalances } from '@Contexts/Settlements/Infrastructure/Ledger/LedgerGroupBalances';
import { SettlementsOutstandingDebtQueries } from '@Contexts/Settlements/Infrastructure/Queries/SettlementsOutstandingDebtQueries';
import { GroupsSettlementMembers } from '@Contexts/Settlements/Infrastructure/Groups/GroupsSettlementMembers';
import { HttpPaymentProvider } from '@Contexts/Settlements/Infrastructure/Provider/HttpPaymentProvider';
import { SqliteSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/Repositories/SqliteSettlementBookRepository';
import { SqliteSettlementQueries } from '@Contexts/Settlements/Infrastructure/Queries/SqliteSettlementQueries';
import { SqlitePayoutAccountQueries } from '@Contexts/Settlements/Infrastructure/Queries/SqlitePayoutAccountQueries';
import { SqlitePayoutAccountRepository } from '@Contexts/Settlements/Infrastructure/Repositories/SqlitePayoutAccountRepository';

/**
 * The Settlements context (conventions/domain.yaml, ADR 6, ADR 7, ADR 8). A settlement is recorded in its group's book, which
 * reads the balances through a port it owns, answered over Ledger's balances read model, and the members in the order they
 * joined through a port it owns, answered over Groups' read model. Both read models are passed in, from the composition root
 * and from Groups' wiring (ARCH-WIRING). A payment through the provider is asked of it through a port this context owns (ADR 6). The settlement read model is the one Ledger reads through its own port (ADR 8), so it
 * is exported for Ledger's wiring, and what is still owed (ADR 10) for Notifications' sweep.
 */
const database = applicationDatabase();
const groupBalances = new LedgerGroupBalances(ledgerBalanceQueries);
const settlementMembers = new GroupsSettlementMembers(groupQueries);
const books = new SqliteSettlementBookRepository(database);
export const settlementQueries = new SqliteSettlementQueries(database);
/** What each current member of every group still owes, for Notifications' sweep (ADR 10, request 18). */
export const outstandingDebtQueries = new SettlementsOutstandingDebtQueries(
  groupQueries,
  groupBalances,
  settlementQueries,
);
const payoutAccounts = new SqlitePayoutAccountRepository(database);
const payoutAccountQueries = new SqlitePayoutAccountQueries(database);
/** The provider is asked where PROVIDER_URL points when a payment is asked, so an unset URL refuses it (request 13). */
const paymentProvider = new HttpPaymentProvider(() => process.env.PROVIDER_URL);
const clock = systemClock;

export const localSettlementsModule = new Module({
  name: 'Settlements',
  commands: [
    {
      event: RecordCashSettlementCommandEvent,
      handlers: [new RecordCashSettlementCommandHandler(settlementMembers, groupBalances, books, clock)],
    },
    {
      event: PayThroughProviderCommandEvent,
      handlers: [
        new PayThroughProviderCommandHandler(
          settlementMembers,
          groupBalances,
          books,
          payoutAccounts,
          paymentProvider,
          clock,
        ),
      ],
    },
    {
      event: ReceivePaymentWebhookCommandEvent,
      handlers: [new ReceivePaymentWebhookCommandHandler(books)],
    },
    {
      event: RefundSettlementCommandEvent,
      handlers: [new RefundSettlementCommandHandler(settlementMembers, books, paymentProvider)],
    },
    {
      event: SetPayoutAccountCommandEvent,
      handlers: [new SetPayoutAccountCommandHandler(payoutAccounts, paymentProvider)],
    },
  ],
  queries: [
    new GetSuggestedSettlementsQueryHandler(groupBalances, settlementMembers, settlementQueries),
    new GetSettlementQueryHandler(settlementQueries, settlementMembers),
    new GetPayoutAccountQueryHandler(payoutAccountQueries),
  ],
});
