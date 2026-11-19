import { CommandEvent } from '@Architecture/Domain';

/** A signed-in person turns a kind of notice on or off (request 36): the kind as the route names it, and the choice. */
export class SetNoticePreferenceCommandEvent extends CommandEvent<{ kind: string; enabled: boolean }> {}
