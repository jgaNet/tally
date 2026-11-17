import { HttpPaymentProvider } from '@Contexts/Settlements/Infrastructure/HttpPaymentProvider';

describe('HttpPaymentProvider: without a provider, a payment is refused and nothing is kept', () => {
  it('refuses with ProviderUnavailable when PROVIDER_URL is not set', async () => {
    const provider = new HttpPaymentProvider(undefined);

    const link = await provider.createPayment({ reference: 'settlement-1', amount: 5, currency: 'EUR' });

    expect(link.isFailure()).toBe(true);
    expect((link.error as { type?: string } | undefined)?.type).toBe('ProviderUnavailable');
  });

  it('refuses a refund with RefundUnavailable when PROVIDER_URL is not set, and nothing changes', async () => {
    const provider = new HttpPaymentProvider(undefined);

    const refused = await provider.refundPayment({ paymentId: 'prov-1', reference: 'settlement-1' });

    expect(refused.isFailure()).toBe(true);
    expect((refused.error as { type?: string } | undefined)?.type).toBe('RefundUnavailable');
  });
});
