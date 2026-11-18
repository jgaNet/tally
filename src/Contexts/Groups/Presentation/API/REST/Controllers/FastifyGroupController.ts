import { FastifyReply, FastifyRequest } from 'fastify';
import { Module } from '@Architecture/Application';
import { acceptCommand } from '@Architecture/Presentation/AcceptCommand';
import {
  ArchiveGroupCommandEvent,
  CreateGroupCommandEvent,
  CreateInvitationCommandEvent,
  LeaveGroupCommandEvent,
  MergeGroupsCommandEvent,
} from '@Contexts/Groups/Application/Commands';
import {
  GetGroupMembersQueryHandler,
  GetGroupQueryHandler,
  GetMyGroupsQueryHandler,
} from '@Contexts/Groups/Application/Queries';
import { refuse } from '@Contexts/Groups/Presentation/API/REST/Controllers/refuse';

export class FastifyGroupController {
  readonly #module: Module;

  constructor({ module }: { module: Module }) {
    this.#module = module;
  }

  createGroup(req: FastifyRequest<{ Body: { name: string; currency: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, CreateGroupCommandEvent.set(req.body));
  }

  async getGroup(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }

  async getMyGroups(req: FastifyRequest, reply: FastifyReply) {
    const result = await this.#module.getQuery(GetMyGroupsQueryHandler).handle(undefined, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }

  createInvitation(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, CreateInvitationCommandEvent.set({ groupId: req.params.id }));
  }

  leaveGroup(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, LeaveGroupCommandEvent.set({ groupId: req.params.id }));
  }

  archiveGroup(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    return acceptCommand(req, reply, this.#module, ArchiveGroupCommandEvent.set({ groupId: req.params.id }));
  }

  mergeGroups(req: FastifyRequest<{ Params: { id: string }; Body: { from: string } }>, reply: FastifyReply) {
    return acceptCommand(
      req,
      reply,
      this.#module,
      MergeGroupsCommandEvent.set({ groupId: req.params.id, from: req.body.from }),
    );
  }

  async getMembers(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const result = await this.#module
      .getQuery(GetGroupMembersQueryHandler)
      .handle({ id: req.params.id }, req.executionContext);
    return result.isFailure() ? refuse(reply, result.error) : result.data;
  }
}
