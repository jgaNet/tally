import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import {
  AcceptInvitationCommandEvent,
  AcceptInvitationCommandHandler,
  CreateGroupCommandEvent,
  CreateGroupCommandHandler,
  CreateInvitationCommandEvent,
  CreateInvitationCommandHandler,
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
import { SqliteAccountReadModels } from '@Contexts/Groups/Infrastructure/SqliteAccountReadModels';
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/SqliteAccountRepository';
import { SqliteGroupReadModels } from '@Contexts/Groups/Infrastructure/SqliteGroupReadModels';
import { SqliteGroupRepository } from '@Contexts/Groups/Infrastructure/SqliteGroupRepository';
import { SqliteInvitationReadModels } from '@Contexts/Groups/Infrastructure/SqliteInvitationReadModels';
import { SqliteInvitationRepository } from '@Contexts/Groups/Infrastructure/SqliteInvitationRepository';
import { authenticateWithToken } from '@Contexts/Groups/Presentation/API/REST/authenticate';

const database = sharedDatabase();
const accounts = new SqliteAccountRepository(database);
const accountReadModels = new SqliteAccountReadModels(database);
const groups = new SqliteGroupRepository(database);
const groupReadModels = new SqliteGroupReadModels(database);
const invitations = new SqliteInvitationRepository(database);
const invitationReadModels = new SqliteInvitationReadModels(database);
const passwordHasher = new ScryptPasswordHasher();
const tokens = HmacTokenIssuer.inDatabase(database);

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
