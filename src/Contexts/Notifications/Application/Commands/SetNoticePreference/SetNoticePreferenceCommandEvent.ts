import { CommandEvent } from '@Architecture/Domain';

/** A person turns a kind of notice on or off (request 36): the kind (from the route) and whether it is on. The person is the caller, not a field. */
export interface SetNoticePreferencePayload {
  kind: string;
  enabled: boolean;
}

export class SetNoticePreferenceCommandEvent extends CommandEvent<SetNoticePreferencePayload> {}
