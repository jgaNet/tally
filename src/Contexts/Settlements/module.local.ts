import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';

import { ledgerBalanceQueries } from '@Bootstrap/Fastify/readModels';
import { groupQueries } from '@Contexts/Groups/module.local';
import {
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';
import {
  RecordCashSettlementCommandEvent,
  RecordCashSettlementCommandHandler,
} from '@Contexts/Settlements/Application/Commands';
import { LedgerGroupBalances } from '@Contexts/Settlements/Infrastructure/Ledger/LedgerGroupBalances';
import { GroupsSettlementMembers } from '@Contexts/Settlements/Infrastructure/Groups/GroupsSettlementMembers';
import { SqliteSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/Repositories/SqliteSettlementBookRepository';
import { SqliteSettlementQueries } from '@Contexts/Settlements/Infrastructure/Queries/SqliteSettlementQueries';

/**
 * The Settlements context (conventions/domain.yaml, ADR 6, ADR 7, ADR 8). A settlement is recorded in its group's book, which
 * reads the balances through a port it owns, answered over Ledger's balances read model, and the members in the order they
 * joined through a port it owns, answered over Groups' read model. Both read models are passed in, from the composition root
 * and from Groups' wiring (ARCH-WIRING). The settlement read model is the one Ledger reads through its own port (ADR 8), so it
 * is exported for Ledger's wiring.
 */
const database = applicationDatabase();
const groupBalances = new LedgerGroupBalances(ledgerBalanceQueries);
const settlementMembers = new GroupsSettlementMembers(groupQueries);
const books = new SqliteSettlementBookRepository(database);
export const settlementQueries = new SqliteSettlementQueries(database);
const clock = systemClock;

export const localSettlementsModule = new Module({
  name: 'Settlements',
  commands: [
    {
      event: RecordCashSettlementCommandEvent,
      handlers: [new RecordCashSettlementCommandHandler(settlementMembers, groupBalances, books, clock)],
    },
  ],
  queries: [
    new GetSuggestedSettlementsQueryHandler(groupBalances, settlementMembers),
    new GetSettlementQueryHandler(settlementQueries, settlementMembers),
  ],
});
