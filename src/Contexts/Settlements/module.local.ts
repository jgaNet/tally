import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { groupCurrencyInCommand, groupMembership, groupMembershipInCommand } from '@Contexts/Groups/module.local';
import { ISettlementEffects } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementEffects';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { IMemberDebts } from '@Contexts/Settlements/Domain/Settlement/Ports/IMemberDebts';
import {
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
import { GetPayoutAccountQueryHandler } from '@Contexts/Settlements/Application/Queries';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { IWaitingEffects } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingEffects';
import { GroupsGroupCurrency } from '@Contexts/Settlements/Infrastructure/GroupsGroupCurrency';
import { GroupsSettlementMembers } from '@Contexts/Settlements/Infrastructure/GroupsSettlementMembers';
import { SqliteSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/SqliteSettlementBookRepository';
import { SqliteSettlementQueries } from '@Contexts/Settlements/Infrastructure/SqliteSettlementQueries';
import { SqliteSettlementEffects } from '@Contexts/Settlements/Infrastructure/SqliteSettlementEffects';
import { SqlitePayoutAccountRepository } from '@Contexts/Settlements/Infrastructure/SqlitePayoutAccountRepository';
import { SqlitePayoutAccountQueries } from '@Contexts/Settlements/Infrastructure/SqlitePayoutAccountQueries';
import { SettlementsMemberDebts } from '@Contexts/Settlements/Infrastructure/SettlementsMemberDebts';

/**
 * The Settlements context (conventions/domain.yaml, ADR 5, ADR 6, ADR 7, ADR 8), kept in the application's SQLite file. Its
 * balances come from Ledger and its members from Groups; neither is imported here beyond the read it exports. Ledger
 * imports this wiring for what was settled (`settlementEffects`), so this wiring does not import Ledger's: the composition
 * root gives it Ledger's balances (`settlementsModuleWith`), and the two wirings do not import each other.
 */
const database = SqliteDatabase.shared();

/**
 * What the settlements paid, as Ledger reads it (SettledAmounts, ADR 7), exported for a query (outside any transaction)
 * and for a command (inside the asking command's transaction).
 */
export const settlementEffects: ISettlementEffects = new SqliteSettlementEffects(database, false, [
  'paid',
  'refunding',
]);
export const settlementEffectsInCommand: ISettlementEffects = new SqliteSettlementEffects(database, true, [
  'paid',
  'refunding',
]);

/** What the payments waiting at the provider do to each balance, for the suggestions (ADR 8), outside any transaction. */
const waitingEffects: IWaitingEffects = new SqliteSettlementEffects(database, false, ['pending']);

/**
 * Who still owes what, as Notifications' sweep asks it (ADR 12), given the balances it reads from Ledger for the sweep
 * (outside any transaction). Exported for the composition root to hand Notifications; this wiring does not import it.
 */
export function memberDebtsWith(balances: IGroupBalances): IMemberDebts {
  return new SettlementsMemberDebts(balances, waitingEffects, new GroupsSettlementMembers(groupMembership));
}

/**
 * The Settlements module, given the balances it decides on: `balances` for its queries (outside a transaction) and
 * `balancesInCommand` for its command (inside the command's transaction, so that two settlements decided at once see each
 * other, ADR 7). The composition root gives both, read from Ledger.
 */
export function settlementsModuleWith(
  balances: IGroupBalances,
  balancesInCommand: IGroupBalances,
  provider: IPaymentProvider,
): Module {
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
      {
        event: PayThroughProviderCommandEvent,
        handlers: [
          new PayThroughProviderCommandHandler(
            new SqliteSettlementBookRepository(database),
            balancesInCommand,
            new GroupsSettlementMembers(groupMembershipInCommand),
            new GroupsGroupCurrency(groupCurrencyInCommand),
            new SqlitePayoutAccountRepository(database),
            provider,
            systemClock,
          ),
        ],
      },
      {
        event: SetPayoutAccountCommandEvent,
        handlers: [new SetPayoutAccountCommandHandler(new SqlitePayoutAccountRepository(database), provider)],
      },
      {
        event: RefundSettlementCommandEvent,
        handlers: [
          new RefundSettlementCommandHandler(
            new SqliteSettlementBookRepository(database),
            new GroupsSettlementMembers(groupMembershipInCommand),
            provider,
            systemClock,
          ),
        ],
      },
      {
        event: ReceivePaymentWebhookCommandEvent,
        handlers: [new ReceivePaymentWebhookCommandHandler(new SqliteSettlementBookRepository(database))],
      },
    ],
    queries: [
      new GetSuggestedSettlementsQueryHandler(balances, waitingEffects, new GroupsSettlementMembers(groupMembership)),
      new GetSettlementQueryHandler(
        new SqliteSettlementQueries(database),
        new GroupsSettlementMembers(groupMembership),
      ),
      new GetPayoutAccountQueryHandler(new SqlitePayoutAccountQueries(database)),
    ],
  });
}
