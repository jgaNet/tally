import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { memberBalances as ledgerMemberBalances } from '@Contexts/Ledger/module.local';
import { groupMembers as groupsMembers } from '@Contexts/Groups/module.local';
import {
  RecordCashSettlementCommandEvent,
  RecordCashSettlementCommandHandler,
} from '@Contexts/Settlements/Application/Commands/RecordCashSettlement';
import {
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';
import { ISettledAmountsQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettledAmountsQueries';
import { GroupBalancesFromLedger } from '@Contexts/Settlements/Infrastructure/GroupBalancesFromLedger';
import { SettlementMembersFromGroups } from '@Contexts/Settlements/Infrastructure/SettlementMembersFromGroups';
import { SqliteSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/SqliteSettlementBookRepository';
import { SqliteSettlementReadModels } from '@Contexts/Settlements/Infrastructure/SqliteSettlementReadModels';

/**
 * The Settlements context, declared by checkpoint 2's strategic session before request 11 (conventions/domain.yaml, ADR 5),
 * and carried from request 11 on (ADR 6): the two ports it owns are answered over Ledger's and Groups' read models. Both are
 * read when they are asked, as the other wiring files' ports are (ADR 4).
 */
const database = sharedDatabase();
const books = new SqliteSettlementBookRepository(database);
const readModels = new SqliteSettlementReadModels(database);

/** What has been settled in a group, read by Ledger when it reads a balance (ADR 7): Settlements' read model, exported. */
export const settledAmounts: ISettledAmountsQueries = readModels;

const balances = new GroupBalancesFromLedger(() => ledgerMemberBalances);
const members = new SettlementMembersFromGroups(() => groupsMembers);

/** The Settlements context: a settlement in cash is decided in its group's book (request 12); suggestions are read (request 11). */
export const localSettlementsModule = new Module({
  name: 'Settlements',
  commands: [
    {
      event: RecordCashSettlementCommandEvent,
      handlers: [new RecordCashSettlementCommandHandler(books, members, balances, systemClock)],
    },
  ],
  queries: [
    new GetSuggestedSettlementsQueryHandler(balances, members),
    new GetSettlementQueryHandler(readModels, members),
  ],
});
