import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

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
  GetGroupSettlementsQueryHandler,
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';
import { IWebhookSignatures } from '@Contexts/Settlements/Application/Ports/IWebhookSignatures';
import {
  SetPayoutAccountCommandEvent,
  SetPayoutAccountCommandHandler,
} from '@Contexts/Settlements/Application/Commands/SetPayoutAccount';
import { GetPayoutAccountQueryHandler } from '@Contexts/Settlements/Application/Queries/GetPayoutAccount';
import { ISettledAmountsQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettledAmountsQueries';
import { IWaitingPaymentsQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingPaymentsQueries';
import { IOutstandingDebtsQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/IOutstandingDebtsQueries';
import { OutstandingDebtsReadModel } from '@Contexts/Settlements/Application/ReadModel/OutstandingDebtsReadModel';
import { GroupBalancesFromLedger } from '@Contexts/Settlements/Infrastructure/GroupBalancesFromLedger';
import { HmacWebhookSignatures } from '@Contexts/Settlements/Infrastructure/HmacWebhookSignatures';
import { HttpPaymentProvider } from '@Contexts/Settlements/Infrastructure/HttpPaymentProvider';
import { SettlementMembersFromGroups } from '@Contexts/Settlements/Infrastructure/SettlementMembersFromGroups';
import { PostgresPayoutAccountReadModels } from '@Contexts/Settlements/Infrastructure/PostgresPayoutAccountReadModels';
import { PostgresPayoutAccountRepository } from '@Contexts/Settlements/Infrastructure/PostgresPayoutAccountRepository';
import { PostgresSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/PostgresSettlementBookRepository';
import { PostgresSettlementReadModels } from '@Contexts/Settlements/Infrastructure/PostgresSettlementReadModels';
import { PostgresSettlementAuditLog } from '@Contexts/Settlements/Infrastructure/PostgresSettlementAuditLog';
import { ISettlementAuditQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementAuditQueries';

/**
 * The Settlements context, declared by checkpoint 2's strategic session before request 11 (conventions/domain.yaml, ADR 5),
 * and carried from request 11 on (ADR 6): the two ports it owns are answered over Ledger's and Groups' read models. Both are
 * read when they are asked, as the other wiring files' ports are (ADR 4). The payment provider and the webhook's signature are
 * read from the environment when they are used, so the server refuses a provider it has no URL for, and nothing else.
 */
const database = sharedDatabase();
const books = new PostgresSettlementBookRepository(database);
const readModels = new PostgresSettlementReadModels(database);
/** The audit of the money the settlements move (request 28), written in each change's transaction and read by Ledger's audit (ADR 19). */
const audit = new PostgresSettlementAuditLog(database);
const payoutAccounts = new PostgresPayoutAccountRepository(database);
const payoutAccountReadModels = new PostgresPayoutAccountReadModels(database);

/** What has been settled in a group, read by Ledger when it reads a balance (ADR 7): Settlements' read model, exported. */
export const settledAmounts: ISettledAmountsQueries = readModels;

/** The money a group's settlements moved, read by Ledger when it reads the group's audit (request 28): Settlements' audit, exported. */
export const settlementAudit: ISettlementAuditQueries = audit;

/** The payments waiting at the provider, which keep a member in the group until they end (request 20): Settlements' read model, exported. */
export const waitingPayments: IWaitingPaymentsQueries = readModels;

/** The signature of the provider's webhooks, checked by the transport before a webhook is decided (request 13). */
export const webhookSignatures: IWebhookSignatures = new HmacWebhookSignatures();

const balances = new GroupBalancesFromLedger(() => ledgerMemberBalances);
const members = new SettlementMembersFromGroups(() => groupsMembers);
const provider = new HttpPaymentProvider();

/**
 * What every current member of every group still owes, read by Notifications' sweep (ADR 10): Settlements' read model, exported.
 * It counts what Ledger counts, and the payments waiting at the provider as paid, as the suggestions do.
 */
export const outstandingDebtsQueries: IOutstandingDebtsQueries = new OutstandingDebtsReadModel(
  balances,
  members,
  readModels,
);

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
      handlers: [new RecordCashSettlementCommandHandler(books, members, balances, systemClock, audit)],
    },
    {
      event: PayThroughProviderCommandEvent,
      handlers: [new PayThroughProviderCommandHandler(books, payoutAccounts, members, balances, provider, systemClock)],
    },
    {
      event: RefundSettlementCommandEvent,
      handlers: [new RefundSettlementCommandHandler(books, members, provider, systemClock)],
    },
    {
      event: ReceivePaymentWebhookCommandEvent,
      handlers: [new ReceivePaymentWebhookCommandHandler(books, systemClock, audit)],
    },
    {
      event: SetPayoutAccountCommandEvent,
      handlers: [new SetPayoutAccountCommandHandler(payoutAccounts, provider)],
    },
  ],
  queries: [
    new GetSuggestedSettlementsQueryHandler(balances, members, readModels),
    new GetGroupSettlementsQueryHandler(readModels, members),
    new GetSettlementQueryHandler(readModels, members),
    new GetPayoutAccountQueryHandler(payoutAccountReadModels),
  ],
});
