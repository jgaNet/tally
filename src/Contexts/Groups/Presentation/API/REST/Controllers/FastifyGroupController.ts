import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommandAtOnce, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import {
  CreateGroupCommandEvent,
  CreateGroupPayload,
  CreateInvitationCommandEvent,
  LeaveGroupCommandEvent,
  ArchiveGroupCommandEvent,
  MergeGroupsCommandEvent,
  SuspendAccountCommandEvent,
  ReinstateAccountCommandEvent,
} from '@Contexts/Groups/Application/Commands';
import {
  GetAdministratorsLogQueryHandler,
  GetGroupMembersQueryHandler,
  GetGroupQueryHandler,
  GetMyGroupsQueryHandler,
} from '@Contexts/Groups/Application/Queries';

/** The routes of groups: a creation answered at once, the reads of the caller's own groups, and the members and invitations of one. */
export class FastifyGroupController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  createGroup(req: FastifyRequest<{ Body: CreateGroupPayload }>, reply: FastifyReply) {
    return acceptCommandAtOnce(req, reply, this.#module, CreateGroupCommandEvent.set(req.body));
  }

  async getGroup(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async getMyGroups(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyGroupsQueryHandler).handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async getAdministratorsLog(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetAdministratorsLogQueryHandler)
      .handle(undefined, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  suspendAccount(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(req, reply, this.#module, SuspendAccountCommandEvent.set({ accountId: req.params.id }));
  }

  reinstateAccount(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      ReinstateAccountCommandEvent.set({ accountId: req.params.id }),
    );
  }

  createInvitation(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(req, reply, this.#module, CreateInvitationCommandEvent.set({ groupId: req.params.id }));
  }

  leaveGroup(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(req, reply, this.#module, LeaveGroupCommandEvent.set({ groupId: req.params.id }));
  }

  archiveGroup(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(req, reply, this.#module, ArchiveGroupCommandEvent.set({ groupId: req.params.id }));
  }

  mergeGroup(req: FastifyRequest<{ Params: { id: string }; Body: { from: string } }>, reply: FastifyReply) {
    return acceptCommandAtOnce(
      req,
      reply,
      this.#module,
      MergeGroupsCommandEvent.set({ groupId: req.params.id, from: req.body.from }),
    );
  }

  async getGroupMembers(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupMembersQueryHandler)
      .handle({ groupId: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { type: error.type, message: error.message };
  }
}
