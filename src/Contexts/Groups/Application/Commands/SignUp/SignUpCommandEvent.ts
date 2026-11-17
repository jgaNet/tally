import { CommandEvent } from '@Architecture/Domain';

/** The payload of a sign-up: what the person typed. The password is never stored, nor kept in an operation. */
export interface SignUpPayload {
  email: string;
  password: string;
  name: string;
}

export class SignUpCommandEvent extends CommandEvent<SignUpPayload> {}
