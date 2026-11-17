import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { memberBalances as ledgerMemberBalances } from '@Contexts/Ledger/module.local';
import { groupMembers as groupsMembers } from '@Contexts/Groups/module.local';
import {
  PayThroughProviderCommandEvent,
  PayThroughProviderCommandHandler,
} from '@Contexts/Settlements/Application/Commands/PayThroughProvider';
import {
  ReceivePaymentWebhookCommandEvent,
  ReceivePaymentWebhookCommandHandler,
} from '@Contexts/Settlements/Application/Commands/ReceivePaymentWebhook';
import {
  RecordCashSettlementCommandEvent,
  RecordCashSettlementCommandHandler,
} from '@Contexts/Settlements/Application/Commands/RecordCashSettlement';
import {
  RefundSettlementCommandEvent,
  RefundSettlementCommandHandler,
} from '@Contexts/Settlements/Application/Commands/RefundSettlement';
import {
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';
import { IWebhookSignatures } from '@Contexts/Settlements/Application/Ports/IWebhookSignatures';
import { ISettledAmountsQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettledAmountsQueries';
import { GroupBalancesFromLedger } from '@Contexts/Settlements/Infrastructure/GroupBalancesFromLedger';
import { HmacWebhookSignatures } from '@Contexts/Settlements/Infrastructure/HmacWebhookSignatures';
import { HttpPaymentProvider } from '@Contexts/Settlements/Infrastructure/HttpPaymentProvider';
import { SettlementMembersFromGroups } from '@Contexts/Settlements/Infrastructure/SettlementMembersFromGroups';
import { SqliteSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/SqliteSettlementBookRepository';
import { SqliteSettlementReadModels } from '@Contexts/Settlements/Infrastructure/SqliteSettlementReadModels';

/**
 * The Settlements context, declared by checkpoint 2's strategic session before request 11 (conventions/domain.yaml, ADR 5),
 * and carried from request 11 on (ADR 6): the two ports it owns are answered over Ledger's and Groups' read models. Both are
 * read when they are asked, as the other wiring files' ports are (ADR 4). The payment provider and the webhook's signature are
 * read from the environment when they are used, so the server refuses a provider it has no URL for, and nothing else.
 */
const database = sharedDatabase();
const books = new SqliteSettlementBookRepository(database);
const readModels = new SqliteSettlementReadModels(database);

/** What has been settled in a group, read by Ledger when it reads a balance (ADR 7): Settlements' read model, exported. */
export const settledAmounts: ISettledAmountsQueries = readModels;

/** The signature of the provider's webhooks, checked by the transport before a webhook is decided (request 13). */
export const webhookSignatures: IWebhookSignatures = new HmacWebhookSignatures();

const balances = new GroupBalancesFromLedger(() => ledgerMemberBalances);
const members = new SettlementMembersFromGroups(() => groupsMembers);
const provider = new HttpPaymentProvider();

/**
 * The Settlements context: a settlement in cash is decided in its group's book (request 12); a payment through the provider is
 * decided there too, and kept pending until the provider's webhook says how it ended (request 13); a paid one may be refunded
 * through the provider (request 15); suggestions are read (request 11).
 */
export const localSettlementsModule = new Module({
  name: 'Settlements',
  commands: [
    {
      event: RecordCashSettlementCommandEvent,
      handlers: [new RecordCashSettlementCommandHandler(books, members, balances, systemClock)],
    },
    {
      event: PayThroughProviderCommandEvent,
      handlers: [new PayThroughProviderCommandHandler(books, members, balances, provider, systemClock)],
    },
    {
      event: RefundSettlementCommandEvent,
      handlers: [new RefundSettlementCommandHandler(books, members, provider)],
    },
    {
      event: ReceivePaymentWebhookCommandEvent,
      handlers: [new ReceivePaymentWebhookCommandHandler(books)],
    },
  ],
  queries: [
    new GetSuggestedSettlementsQueryHandler(balances, members, readModels),
    new GetSettlementQueryHandler(readModels, members),
  ],
});
