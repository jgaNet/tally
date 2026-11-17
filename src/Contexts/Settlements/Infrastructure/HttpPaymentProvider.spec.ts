import { HttpPaymentProvider } from '@Contexts/Settlements/Infrastructure/HttpPaymentProvider';

describe('HttpPaymentProvider: without a provider, a payment is refused and nothing is kept', () => {
  it('refuses with ProviderUnavailable when PROVIDER_URL is not set', async () => {
    const provider = new HttpPaymentProvider(undefined);

    const link = await provider.createPayment({
      reference: 'settlement-1',
      amount: 5,
      currency: 'EUR',
      payee: 'acct-1',
    });

    expect(link.isFailure()).toBe(true);
    expect((link.error as { type?: string } | undefined)?.type).toBe('ProviderUnavailable');
  });

  it('refuses a payout account with ProviderAccountUnavailable when PROVIDER_URL is not set (request 16)', async () => {
    const provider = new HttpPaymentProvider(undefined);

    const answer = await provider.findPayoutAccount('acct-1');

    expect(answer.isFailure()).toBe(true);
    expect((answer.error as { type?: string } | undefined)?.type).toBe('ProviderAccountUnavailable');
  });

  it('refuses a refund with RefundUnavailable when PROVIDER_URL is not set, and nothing changes', async () => {
    const provider = new HttpPaymentProvider(undefined);

    const refused = await provider.refundPayment({ paymentId: 'prov-1', reference: 'settlement-1' });

    expect(refused.isFailure()).toBe(true);
    expect((refused.error as { type?: string } | undefined)?.type).toBe('RefundUnavailable');
  });
});
