import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import {
  AcceptInvitationCommandEvent,
  AcceptInvitationCommandHandler,
  ArchiveGroupCommandEvent,
  ArchiveGroupCommandHandler,
  CreateGroupCommandEvent,
  CreateGroupCommandHandler,
  CreateInvitationCommandEvent,
  CreateInvitationCommandHandler,
  LeaveGroupCommandEvent,
  LeaveGroupCommandHandler,
  SignUpCommandEvent,
  SignUpCommandHandler,
} from '@Contexts/Groups/Application/Commands';
import {
  GetGroupMembersQueryHandler,
  GetGroupQueryHandler,
  GetInvitationQueryHandler,
  GetMyAccountQueryHandler,
  GetMyGroupsQueryHandler,
  LoginQueryHandler,
} from '@Contexts/Groups/Application/Queries';
import { HmacTokenIssuer } from '@Contexts/Groups/Infrastructure/HmacTokenIssuer';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { PostgresAccountReadModels } from '@Contexts/Groups/Infrastructure/PostgresAccountReadModels';
import { PostgresAccountRepository } from '@Contexts/Groups/Infrastructure/PostgresAccountRepository';
import { PostgresGroupReadModels } from '@Contexts/Groups/Infrastructure/PostgresGroupReadModels';
import { PostgresGroupRepository } from '@Contexts/Groups/Infrastructure/PostgresGroupRepository';
import { PostgresInvitationReadModels } from '@Contexts/Groups/Infrastructure/PostgresInvitationReadModels';
import { PostgresInvitationRepository } from '@Contexts/Groups/Infrastructure/PostgresInvitationRepository';
import { authenticateWithToken } from '@Contexts/Groups/Presentation/API/REST/authenticate';
import { BalancesFromLedger } from '@Contexts/Groups/Infrastructure/BalancesFromLedger';
import { memberBalances as ledgerMemberBalances } from '@Contexts/Ledger/module.local';
import { waitingPayments as settlementsWaitingPayments } from '@Contexts/Settlements/module.local';
import { WaitingPaymentsFromSettlements } from '@Contexts/Groups/Infrastructure/WaitingPaymentsFromSettlements';
import { IGroupMembersQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembersQueries';
import { IGroupAuditQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupAuditQueries';
import { PostgresGroupAuditLog } from '@Contexts/Groups/Infrastructure/PostgresGroupAuditLog';

const database = sharedDatabase();
const accounts = new PostgresAccountRepository(database);
const accountReadModels = new PostgresAccountReadModels(database);
const groups = new PostgresGroupRepository(database);
const groupReadModels = new PostgresGroupReadModels(database);
const invitations = new PostgresInvitationRepository(database);
const invitationReadModels = new PostgresInvitationReadModels(database);
const passwordHasher = new ScryptPasswordHasher();
const tokens = HmacTokenIssuer.inDatabase(database);

/**
 * The membership Ledger splits expenses with (ADR 3): a read-model adapter, exported for the Ledger's wiring to take up
 * through its own port. Nothing else of Groups is exported.
 */
export const groupMembers: IGroupMembersQueries = groupReadModels;

/** The balances passed to the owner when members left (request 28), read by Ledger's audit: Groups' audit, exported (ADR 19). */
const audit = new PostgresGroupAuditLog(database);
export const groupAudit: IGroupAuditQueries = audit;

/**
 * The balance a member has in a group, read from Ledger's read model before the member may leave it (ADR 4). Ledger's
 * wiring imports `groupMembers` from this file, so the two files import each other: the adapter reads Ledger's export
 * when the balance is asked, not while this file is evaluated.
 */
const balances = new BalancesFromLedger(() => ledgerMemberBalances);

/**
 * The payments a member pays or receives that are waiting at the provider, read from Settlements' read model before the member may
 * leave (request 20). Settlements' wiring imports `groupMembers` from this file, so the adapter reads Settlements' export when it is
 * asked, not while this file is evaluated.
 */
const waiting = new WaitingPaymentsFromSettlements(() => settlementsWaitingPayments);

/** Says who is calling, for the transport: the account a bearer token names. */
export const authenticate = authenticateWithToken(tokens, systemClock);

/** The Groups context: who someone is (ADR 1: accounts live here), and the groups they are in, and how they join. */
export const localGroupsModule = new Module({
  name: 'Groups',
  commands: [
    { event: SignUpCommandEvent, handlers: [new SignUpCommandHandler(accounts, passwordHasher)] },
    { event: CreateGroupCommandEvent, handlers: [new CreateGroupCommandHandler(groups, systemClock)] },
    {
      event: CreateInvitationCommandEvent,
      handlers: [new CreateInvitationCommandHandler(groups, invitations, systemClock)],
    },
    {
      event: AcceptInvitationCommandEvent,
      handlers: [new AcceptInvitationCommandHandler(invitations, groups, systemClock)],
    },
    {
      event: LeaveGroupCommandEvent,
      handlers: [new LeaveGroupCommandHandler(groups, balances, waiting, systemClock, audit)],
    },
    {
      event: ArchiveGroupCommandEvent,
      handlers: [new ArchiveGroupCommandHandler(groups, balances, waiting, systemClock)],
    },
  ],
  queries: [
    new GetMyAccountQueryHandler(accountReadModels),
    new LoginQueryHandler(accountReadModels, passwordHasher, tokens, systemClock),
    new GetGroupQueryHandler(groupReadModels),
    new GetMyGroupsQueryHandler(groupReadModels),
    new GetInvitationQueryHandler(invitationReadModels),
    new GetGroupMembersQueryHandler(groupReadModels),
  ],
});
