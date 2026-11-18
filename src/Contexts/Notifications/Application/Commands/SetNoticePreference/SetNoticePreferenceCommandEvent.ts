import { CommandEvent } from '@Architecture/Domain';

/** A signed-in person turns a kind of notice on or off for themselves (request 36). The kind is checked by the preferences, behind the 202. */
export class SetNoticePreferenceCommandEvent extends CommandEvent<{ kind: string; enabled: boolean }> {}
