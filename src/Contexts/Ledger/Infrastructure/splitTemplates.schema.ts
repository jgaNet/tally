/**
 * The split templates in the SQLite file (request 25). A template is one row of `ledger_split_templates`, at its version,
 * unique by group and name key (the name in lower case, so two names of a group that differ only in case are one name); its
 * split is one row of `ledger_split_template_members` per member, in the order given, with its shares (1 for each member of
 * an equal split). The rows of a template are read in the order they were saved, by rowid.
 */
export const SPLIT_TEMPLATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ledger_split_templates (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     name TEXT NOT NULL,
     name_key TEXT NOT NULL,
     saved_by TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('between', 'shares')),
     version INTEGER NOT NULL,
     UNIQUE (group_id, name_key)
   )`,
  `CREATE TABLE IF NOT EXISTS ledger_split_template_members (
     template_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     member_id TEXT NOT NULL,
     shares INTEGER NOT NULL,
     PRIMARY KEY (template_id, position)
   )`,
];
