import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './database';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/** The kinds of notice, in the order they are listed. */
export const NOTICE_KINDS = ['expense', 'reminder', 'budget'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** A kind of notice, and whether the person receives it. */
export interface NoticePreference {
  kind: NoticeKind;
  enabled: boolean;
}

function isNoticeKind(value: string): value is NoticeKind {
  return (NOTICE_KINDS as readonly string[]).includes(value);
}

/**
 * Whether the person receives notices of the kind now. Every kind is on until the person turns it off, so an account with no
 * preference for it receives it. It is read inside the write transaction that would make the notice, so a change made
 * meanwhile is seen.
 */
export async function isNoticeOn(db: Queryable, accountId: string, kind: NoticeKind): Promise<boolean> {
  const row = await db.get<{ enabled: boolean }>(
    'SELECT enabled FROM notice_preferences WHERE account_id = ? AND kind = ?',
    [accountId, kind],
  );
  return row?.enabled ?? true;
}

/** The person's preferences: each kind of notice, on or off, in the order of `NOTICE_KINDS`. Only the person reads their own. */
export async function listNoticePreferencesOf(db: Queryable, accountId: string): Promise<NoticePreference[]> {
  const rows = await db.all<{ kind: NoticeKind; enabled: boolean }>(
    'SELECT kind, enabled FROM notice_preferences WHERE account_id = ?',
    [accountId],
  );
  return NOTICE_KINDS.map(kind => ({
    kind,
    enabled: rows.find(row => row.kind === kind)?.enabled ?? true,
  }));
}

/**
 * Turns the kind of notice on or off for the person. A notice of a kind turned off is not made for them from then on, and
 * one of a kind turned on again is made from then on; nothing made before changes. The change is one write transaction,
 * so the notices made by the others are ordered against it. A kind that is not one of `NOTICE_KINDS` is refused with
 * `InvalidKind`.
 */
export async function setNoticePreference(
  db: Database,
  accountId: string,
  kind: string,
  enabled: boolean,
): Promise<void> {
  if (!isNoticeKind(kind)) {
    throw new Refusal(422, 'InvalidKind', `The kind must be one of ${NOTICE_KINDS.join(', ')}.`);
  }
  await db.transaction(async tx => {
    await tx.run(
      `INSERT INTO notice_preferences (account_id, kind, enabled) VALUES (?, ?, ?)
       ON CONFLICT (account_id, kind) DO UPDATE SET enabled = excluded.enabled`,
      [accountId, kind, enabled],
    );
  });
}

const preferenceSchema = {
  type: 'object',
  required: ['kind', 'enabled'],
  properties: {
    kind: { enum: [...NOTICE_KINDS] },
    enabled: { type: 'boolean' },
  },
};

export function registerNoticePreferenceRoutes(app: FastifyInstance, db: Database): void {
  app.get(
    '/accounts/me/notice-preferences',
    { schema: { response: { 200: { type: 'array', items: preferenceSchema } } } },
    async request => listNoticePreferencesOf(db, await requireCaller(db, request)),
  );

  app.put<{ Params: { kind: string }; Body: { enabled: boolean } }>(
    '/accounts/me/notice-preferences/:kind',
    {
      schema: {
        body: {
          type: 'object',
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const accountId = await requireCaller(db, request);
      await setNoticePreference(db, accountId, request.params.kind, request.body.enabled);
      return reply.code(204).send();
    },
  );
}
