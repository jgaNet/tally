import { CommandEvent } from '@Architecture/Domain';

/**
 * The payer of an expense, or the group's owner, attaches a receipt to it, replacing the one it had: the file as it was sent. Its type and
 * size are read from the bytes, behind the 202, and the file is sent to the receipts store only once they and the rule are right.
 */
export class AttachReceiptCommandEvent extends CommandEvent<{ expenseId: string; bytes: Uint8Array }> {}
