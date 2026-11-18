import type { LegacyUpgrade } from '@Bootstrap/Database/moveSqliteFile';

import { upgradeGroupsFile } from '@Bootstrap/Database/legacy/GroupsLegacyFile';
import { upgradeLedgerFile } from '@Bootstrap/Database/legacy/LedgerLegacyFile';
import { upgradeNotificationsFile } from '@Bootstrap/Database/legacy/NotificationsLegacyFile';
import { upgradeSettlementsFile } from '@Bootstrap/Database/legacy/SettlementsLegacyFile';

/**
 * The upgrades of the SQLite file an earlier version kept, in the order the contexts were wired (docs/adr/0029). Each
 * context's upgrade is the schema steps its adapters ran on opening the file.
 */
export const LEGACY_UPGRADES: LegacyUpgrade[] = [
  upgradeGroupsFile,
  upgradeLedgerFile,
  upgradeSettlementsFile,
  upgradeNotificationsFile,
];
