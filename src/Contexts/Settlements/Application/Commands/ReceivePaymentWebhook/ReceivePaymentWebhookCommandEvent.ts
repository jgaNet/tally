import { CommandEvent } from '@Architecture/Domain';

/**
 * The provider's webhook, as it was signed and sent: the webhook's own id, the payment's id at the provider, its status
 * (`pending`, `succeeded` or `failed`) and when the provider decided it.
 */
export class ReceivePaymentWebhookCommandEvent extends CommandEvent<{
  webhookId: string;
  paymentId: string;
  status: string;
  at: string;
}> {}
