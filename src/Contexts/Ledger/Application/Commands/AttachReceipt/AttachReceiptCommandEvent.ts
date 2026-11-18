import { CommandEvent } from '@Architecture/Domain';

/** Attaches a receipt to an expense: the file as it was sent (a JPEG or a PNG of at most 2 MB), which replaces the one it had. */
export class AttachReceiptCommandEvent extends CommandEvent<{
  expenseId: string;
  bytes: Uint8Array;
}> {}
