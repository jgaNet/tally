import { CommandEvent } from '@Architecture/Domain';

/**
 * The provider's webhook, once its signature is proved at the transport: the payment it is about and the status the provider
 * gives it. The status is the domain's to read; the webhook's own id and time are the transport's to check, not kept.
 */
export interface ReceivePaymentWebhookPayload {
  paymentId: string;
  status: string;
}

export class ReceivePaymentWebhookCommandEvent extends CommandEvent<ReceivePaymentWebhookPayload> {}
