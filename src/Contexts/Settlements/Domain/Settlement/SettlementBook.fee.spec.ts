import { Id } from '@Architecture/Domain';
import { FeePolicySetEvent } from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import { payerPartOf, settledAmountOf, SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import {
  InvalidFeePolicy,
  OnlyTheOwnerSetsFeePolicy,
  ProviderFeeOutOfRange,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { GroupArchived } from '@SharedKernel/Domain';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const payer = new Id('payer');
const payee = new Id('payee');
const members = ['payer', 'payee'];
const balances = new Map([
  ['payer', -300],
  ['payee', 300],
]);

/** A book where the owner set the policy (or none), with one payment of 300 asked and given a fee of 31 by the provider. */
function askedWith(borneBy: string | undefined, fee = 31) {
  const book = SettlementBook.open(Id.generate(), 0);
  if (borneBy !== undefined) {
    const set = book.setFeePolicy({ borneBy, by: payee, callerIsOwner: true, groupArchived: false, at: NOW });
    if (set.isFailure()) throw new Error('the policy must be set');
  }
  const proposal = book.proposePayment({
    groupArchived: false,
    payer,
    payee,
    amount: 300,
    balances,
    members,
    payeeAccount: 'acct-payee',
  });
  if (proposal.isFailure()) throw new Error('the payment must be proposed');
  const kept = book.keepPayment(proposal.data, { id: 'prov-1', payUrl: 'https://pay.example/prov-1', fee }, NOW);
  return { book, kept };
}

describe('what a settlement through the provider settles (request 38)', () => {
  it('settles its whole amount when the payee bears the fee, and the payee is the one who bears it until decided', () => {
    const { kept } = askedWith(undefined);
    if (kept.isFailure()) throw new Error('the payment must be kept');
    expect(kept.data.settled).toBe(300);
    expect(kept.data.amount).toBe(300);
    expect(kept.data.fee).toEqual({ amount: 31, borneBy: 'payee' });
  });

  it('settles its amount less the fee when the payer bears it', () => {
    const { kept } = askedWith('payer');
    if (kept.isFailure()) throw new Error('the payment must be kept');
    expect(kept.data.settled).toBe(269);
    expect(kept.data.fee).toEqual({ amount: 31, borneBy: 'payer' });
  });

  it('settles its amount less the payer half when shared: the payee bears the extra hundredth of an odd fee', () => {
    const { kept } = askedWith('shared');
    if (kept.isFailure()) throw new Error('the payment must be kept');
    expect(kept.data.settled).toBe(285);
    expect(payerPartOf({ amount: 31, borneBy: 'shared' })).toBe(15);
    expect(settledAmountOf(300, { amount: 31, borneBy: 'shared' })).toBe(285);
  });

  it('keeps the policy it was asked with: a later change changes no settlement', () => {
    const { book, kept } = askedWith('payer');
    if (kept.isFailure()) throw new Error('the payment must be kept');
    const changed = book.setFeePolicy({
      borneBy: 'payee',
      by: payee,
      callerIsOwner: true,
      groupArchived: false,
      at: NOW,
    });
    expect(changed.isSuccess()).toBe(true);
    expect(kept.data.fee).toEqual({ amount: 31, borneBy: 'payer' });
    expect(kept.data.settled).toBe(269);
  });

  it('still owes the fee the payer bears while the payment waits: the suggestions count what settles', () => {
    const { book, kept } = askedWith('payer');
    if (kept.isFailure()) throw new Error('the payment must be kept');
    const owing = book.stillOwing(balances);
    // The payer owed 300 and the waiting payment settles 269: 31 is still owed by the payer.
    expect(owing.get('payer')).toBe(-31);
    expect(owing.get('payee')).toBe(31);
  });

  it('settles a settlement asked without a fee as its amount, and reads no fee of it', () => {
    const { book } = askedWith(undefined, 0);
    expect(book.unsaved).toHaveLength(1);
    expect(book.unsaved[0]?.settled).toBe(300);
  });
});

describe('the provider fee the book refuses (request 38)', () => {
  it.each([
    ['a fee equal to the amount', 300],
    ['a fee above the amount', 301],
    ['a negative fee', -1],
    ['a fee that is not a whole number', 1.5],
  ])('refuses %s, and keeps nothing', (_, fee) => {
    const { book, kept } = askedWith('payer', fee);
    expect(kept.isFailure()).toBe(true);
    if (kept.isFailure()) expect(kept.error).toBeInstanceOf(ProviderFeeOutOfRange);
    expect(book.unsaved).toHaveLength(0);
  });
});

describe('who decides who bears the fee (request 38)', () => {
  it('is the payee until the owner decides', () => {
    expect(SettlementBook.open(Id.generate(), 0).feePolicy).toBe('payee');
  });

  it('is changed by the owner, and records FeePolicySet', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const set = book.setFeePolicy({ borneBy: 'shared', by: payee, callerIsOwner: true, groupArchived: false, at: NOW });
    expect(set.isSuccess()).toBe(true);
    expect(book.feePolicy).toBe('shared');
    expect(book.pullDomainEvents().some(event => event instanceof FeePolicySetEvent)).toBe(true);
  });

  it('is refused to a member who is not the owner, and nothing changes', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const set = book.setFeePolicy({ borneBy: 'payer', by: payer, callerIsOwner: false, groupArchived: false, at: NOW });
    expect(set.isFailure()).toBe(true);
    if (set.isFailure()) expect(set.error).toBeInstanceOf(OnlyTheOwnerSetsFeePolicy);
    expect(book.feePolicy).toBe('payee');
  });

  it('is refused in an archived group', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const set = book.setFeePolicy({ borneBy: 'payer', by: payee, callerIsOwner: true, groupArchived: true, at: NOW });
    if (set.isFailure()) expect(set.error).toBeInstanceOf(GroupArchived);
    expect(set.isFailure()).toBe(true);
  });

  it('refuses a value that is not payer, payee or shared', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const set = book.setFeePolicy({ borneBy: 'nobody', by: payee, callerIsOwner: true, groupArchived: false, at: NOW });
    expect(set.isFailure()).toBe(true);
    if (set.isFailure()) expect(set.error).toBeInstanceOf(InvalidFeePolicy);
    expect(book.feePolicy).toBe('payee');
  });
});
