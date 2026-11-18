import type { FastifyInstance } from 'fastify';
import type { Database } from '../database';
import { requireCaller } from '../http';
import { noticePreferencesOf, setNoticePreference } from '../notice-preferences';

/** Only the shape is checked here (a missing or wrongly typed `enabled` is `400`). */
const SET_PREFERENCE_BODY = {
  type: 'object',
  required: ['enabled'],
  properties: { enabled: { type: 'boolean' } },
};

const NOTICE_PREFERENCE = {
  type: 'object',
  required: ['kind', 'enabled'],
  properties: {
    kind: { enum: ['expense', 'reminder', 'budget'] },
    enabled: { type: 'boolean' },
  },
};

export function registerNoticePreferenceRoutes(server: FastifyInstance, db: Database): void {
  // Only the caller's own preferences are read: nobody else reads them.
  server.get(
    '/accounts/me/notice-preferences',
    { schema: { response: { 200: { type: 'array', items: NOTICE_PREFERENCE } } } },
    async request => {
      const caller = await requireCaller(db, request);
      return await noticePreferencesOf(db, caller.id);
    },
  );

  // The caller turns a kind of notice on or off for themselves; the others of their groups are not affected.
  server.put<{ Params: { kind: string }; Body: { enabled: boolean } }>(
    '/accounts/me/notice-preferences/:kind',
    { schema: { body: SET_PREFERENCE_BODY } },
    async (request, reply) => {
      const caller = await requireCaller(db, request);
      await setNoticePreference(db, {
        accountId: caller.id,
        kind: request.params.kind,
        enabled: request.body.enabled,
      });
      return reply.code(204).send();
    },
  );
}
