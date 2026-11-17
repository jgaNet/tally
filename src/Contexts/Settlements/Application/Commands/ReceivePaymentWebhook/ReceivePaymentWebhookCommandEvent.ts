import { CommandEvent } from '@Architecture/Domain';

/** The provider's webhook, once its signature is checked: its own id, the payment's id, the payment's status, and when it was decided. */
export class ReceivePaymentWebhookCommandEvent extends CommandEvent<{
  id: string;
  paymentId: string;
  status: string;
  at: string;
}> {}
