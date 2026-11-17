import { CommandEvent } from '@Architecture/Domain';

export class SignUpCommandEvent extends CommandEvent<{ email: string; password: string; name: string }> {}
