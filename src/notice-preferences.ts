import type { Database, Querier } from './database';
import { Refusal } from './refusal';
import { inTransaction } from './transactions';

/** The kinds of notice, in the order they are read. */
export const NOTICE_KINDS = ['expense', 'reminder', 'budget'] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** One kind of notice of a person, on or off. */
export interface NoticePreference {
  readonly kind: NoticeKind;
  readonly enabled: boolean;
}

function isNoticeKind(kind: string): kind is NoticeKind {
  return (NOTICE_KINDS as readonly string[]).includes(kind);
}

/**
 * The notice preferences of `accountId`: each kind, in the order of {@link NOTICE_KINDS}, on or off. Every kind is on until
 * its person turns it off. Reading changes nothing.
 */
export async function noticePreferencesOf(db: Querier, accountId: string): Promise<NoticePreference[]> {
  const rows = await db
    .prepare('SELECT kind, enabled FROM notice_preferences WHERE account_id = ?')
    .all<{ kind: NoticeKind; enabled: boolean }>(accountId);
  return NOTICE_KINDS.map(kind => {
    const row = rows.find(stored => stored.kind === kind);
    return { kind, enabled: row === undefined ? true : row.enabled };
  });
}

/**
 * Turns a kind of notice on or off for `accountId`. From the moment it is written, a notice of that kind is not made for
 * the account (when off), or is made again (when on): nothing made earlier changes, and nothing missed while it was off
 * is made later. Refused with `422` as `NoticeKindIsUnsupported` when the kind is not one of {@link NOTICE_KINDS}.
 *
 * It is written in one write transaction, so every notice made by a transaction that runs after this one sees it.
 */
export async function setNoticePreference(
  db: Database,
  input: { accountId: string; kind: string; enabled: boolean },
): Promise<void> {
  const { accountId, enabled } = input;
  if (!isNoticeKind(input.kind)) {
    throw new Refusal(422, 'NoticeKindIsUnsupported', `The kind of notice must be one of ${NOTICE_KINDS.join(', ')}.`);
  }
  const kind = input.kind;
  await inTransaction(db, async tx => {
    await tx
      .prepare(
        `INSERT INTO notice_preferences (account_id, kind, enabled) VALUES (?, ?, ?)
         ON CONFLICT (account_id, kind) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(accountId, kind, enabled);
  });
}

/**
 * The ids, among `accountIds`, of the accounts that have turned notices of `kind` off. Called by the transaction that makes
 * the notices, so what it answers is what the notices are made with.
 */
export async function turnedOffAmong(
  db: Querier,
  accountIds: readonly string[],
  kind: NoticeKind,
): Promise<Set<string>> {
  const off = new Set<string>();
  for (const accountId of new Set(accountIds)) {
    const row = await db
      .prepare('SELECT 1 FROM notice_preferences WHERE account_id = ? AND kind = ? AND enabled = FALSE')
      .get(accountId, kind);
    if (row !== undefined) off.add(accountId);
  }
  return off;
}
