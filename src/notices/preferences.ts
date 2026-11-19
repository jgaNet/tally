import { type Database, inTransaction } from '../database';
import { Refusal } from '../refusal';

/** The kinds of notice, in the order a person's preferences are listed. */
export const NOTICE_KINDS = ['expense', 'reminder', 'budget'] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** Whether a kind of notice is made for a person. */
export interface NoticePreference {
  kind: NoticeKind;
  enabled: boolean;
}

/** The notice kind `text` names: a refusal (`422`) when it is none of the kinds. */
export function noticeKindOf(text: string): NoticeKind {
  if (!(NOTICE_KINDS as readonly string[]).includes(text)) {
    throw new Refusal(422, 'InvalidNoticeKind', `The notice kind must be one of ${NOTICE_KINDS.join(', ')}.`);
  }
  return text as NoticeKind;
}

/** Whether a notice of `kind` is made for `accountId` now. Every kind is on until it is turned off. */
export async function isNoticeOn(db: Database, accountId: string, kind: NoticeKind): Promise<boolean> {
  const row = await db.row<{ enabled: boolean }>(
    'SELECT enabled FROM notice_preferences WHERE account_id = ? AND kind = ?',
    [accountId, kind],
  );
  return row?.enabled ?? true;
}

/** The signed-in account's own preferences, each kind in order, on or off. Reading changes nothing. */
export async function preferencesOf(db: Database, accountId: string): Promise<NoticePreference[]> {
  const rows = await db.rows<{ kind: NoticeKind; enabled: boolean }>(
    'SELECT kind, enabled FROM notice_preferences WHERE account_id = ?',
    [accountId],
  );
  return NOTICE_KINDS.map(kind => ({ kind, enabled: rows.find(row => row.kind === kind)?.enabled ?? true }));
}

/** Turns a kind of notice on or off for `accountId`. Notices made before it changes are left as they are. */
export async function setNoticePreference(
  db: Database,
  accountId: string,
  kind: NoticeKind,
  enabled: boolean,
): Promise<void> {
  await inTransaction(db, async () => {
    await db.execute(
      `INSERT INTO notice_preferences (account_id, kind, enabled) VALUES (?, ?, ?)
       ON CONFLICT (account_id, kind) DO UPDATE SET enabled = excluded.enabled`,
      [accountId, kind, enabled],
    );
  });
}
