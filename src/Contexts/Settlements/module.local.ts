import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { groupMembership, groupMembershipInCommand } from '@Contexts/Groups/module.local';
import { ISettlementEffects } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementEffects';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import {
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';
import {
  RecordCashSettlementCommandEvent,
  RecordCashSettlementCommandHandler,
} from '@Contexts/Settlements/Application/Commands';
import { GroupsSettlementMembers } from '@Contexts/Settlements/Infrastructure/GroupsSettlementMembers';
import { SqliteSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/SqliteSettlementBookRepository';
import { SqliteSettlementQueries } from '@Contexts/Settlements/Infrastructure/SqliteSettlementQueries';
import { SqliteSettlementEffects } from '@Contexts/Settlements/Infrastructure/SqliteSettlementEffects';

/**
 * The Settlements context (conventions/domain.yaml, ADR 5, ADR 6, ADR 7), kept in the application's SQLite file. Its
 * balances come from Ledger and its members from Groups; neither is imported here beyond the read it exports. Ledger
 * imports this wiring for what was settled (`settlementEffects`), so this wiring does not import Ledger's: the composition
 * root gives it Ledger's balances (`settlementsModuleWith`), and the two wirings do not import each other.
 */
const database = SqliteDatabase.shared();

/**
 * What the settlements paid, as Ledger reads it (SettledAmounts, ADR 7), exported for a query (outside any transaction)
 * and for a command (inside the asking command's transaction).
 */
export const settlementEffects: ISettlementEffects = new SqliteSettlementEffects(database, false);
export const settlementEffectsInCommand: ISettlementEffects = new SqliteSettlementEffects(database, true);

/**
 * The Settlements module, given the balances it decides on: `balances` for its queries (outside a transaction) and
 * `balancesInCommand` for its command (inside the command's transaction, so that two settlements decided at once see each
 * other, ADR 7). The composition root gives both, read from Ledger.
 */
export function settlementsModuleWith(balances: IGroupBalances, balancesInCommand: IGroupBalances): Module {
  return new Module({
    name: 'Settlements',
    commands: [
      {
        event: RecordCashSettlementCommandEvent,
        handlers: [
          new RecordCashSettlementCommandHandler(
            new SqliteSettlementBookRepository(database),
            balancesInCommand,
            new GroupsSettlementMembers(groupMembershipInCommand),
            systemClock,
          ),
        ],
      },
    ],
    queries: [
      new GetSuggestedSettlementsQueryHandler(balances, new GroupsSettlementMembers(groupMembership)),
      new GetSettlementQueryHandler(
        new SqliteSettlementQueries(database),
        new GroupsSettlementMembers(groupMembership),
      ),
    ],
  });
}
