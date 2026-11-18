import { CommandEvent } from '@Architecture/Domain';

/**
 * The payload of an attachment: the expense (as the route names it), and the file as the body sent it. The attacher is the caller,
 * not a field; the file is judged by the domain, not here (request 26).
 */
export interface AttachReceiptPayload {
  expenseId: string;
  bytes: Uint8Array;
}

export class AttachReceiptCommandEvent extends CommandEvent<AttachReceiptPayload> {}
