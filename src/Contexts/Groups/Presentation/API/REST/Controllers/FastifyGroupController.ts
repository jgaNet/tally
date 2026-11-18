import { FastifyReply, FastifyRequest } from 'fastify';

import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { ExecutionContext, Module } from '@Architecture/Application';
import { acceptCommand, notAllowedStatus } from '@Architecture/Presentation/AcceptCommand';

import {
  AcceptInvitationCommandEvent,
  ArchiveGroupCommandEvent,
  CreateGroupCommandEvent,
  CreateInvitationCommandEvent,
  LeaveGroupCommandEvent,
} from '@Contexts/Groups/Application/Commands';
import {
  GetGroupMembersQueryHandler,
  GetGroupQueryHandler,
  GetInvitationQueryHandler,
  GetMyGroupsQueryHandler,
} from '@Contexts/Groups/Application/Queries';

export class FastifyGroupController {
  #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  async createGroup(req: FastifyRequest<{ Body: { name: string; currency: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, CreateGroupCommandEvent.set(req.body));
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

  async createInvitation(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, CreateInvitationCommandEvent.set({ groupId: req.params.id }));
  }

  async getInvitation(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetInvitationQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  async acceptInvitation(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, AcceptInvitationCommandEvent.set({ invitationId: req.params.id }));
  }

  async archiveGroup(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, ArchiveGroupCommandEvent.set({ groupId: req.params.id }));
  }

  async leaveGroup(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, LeaveGroupCommandEvent.set({ groupId: req.params.id }));
  }

  async getGroupMembers(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupMembersQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);

    return result.isFailure() ? this.refuse(reply, result.error, req.executionContext) : result.data;
  }

  private refuse(reply: FastifyReply, error: Exception, context: ExecutionContext) {
    if (error instanceof NotAllowedException) reply.code(notAllowedStatus(context));
    else if (error instanceof NotFoundException) reply.code(404);
    else reply.code(400);

    return { message: error.message };
  }
}
