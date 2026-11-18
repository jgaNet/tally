import { Id } from '@Architecture/Domain';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/** Every status a settlement has had, the earliest first, with when Tally learned it (request 19). */

const asked = new Date('2026-01-01T10:00:00.000Z');
const heard = new Date('2026-01-02T11:00:00.000Z');
const later = new Date('2026-01-03T12:00:00.000Z');

const payer = new Id('payer');
const payee = new Id('payee');
const members = ['payer', 'payee'];
const balances = new Map([
  ['payer', -30],
  ['payee', 30],
]);

function recordedInCash(): { book: SettlementBook; settlementId: Id } {
  const book = SettlementBook.open(Id.generate(), 0);
  const recorded = book.recordCash({ groupArchived: false, payer, payee, amount: 30, balances, members, at: asked });
  if (recorded.isFailure()) throw new Error('the cash settlement must be recorded');
  return { book, settlementId: recorded.data.id };
}

function askedThroughProvider(): { book: SettlementBook; settlementId: Id } {
  const book = SettlementBook.open(Id.generate(), 0);
  const proposal = book.proposePayment({
    groupArchived: false,
    payer,
    payee,
    amount: 30,
    balances,
    members,
    payeeAccount: 'acct-payee',
  });
  if (proposal.isFailure()) throw new Error('the payment must be proposed');
  const kept = book.keepPayment(proposal.data, { id: 'prov-1', payUrl: 'https://pay.example/prov-1' }, asked);
  if (kept.isFailure()) throw new Error('the payment must be kept');
  return { book, settlementId: proposal.data.id };
}

/** The history the book holds for a settlement it keeps this transaction, read from the statuses it stores. */
function storedLines(book: SettlementBook, settlementId: Id) {
  return book.unsavedHistory
    .filter(change => change.settlementId.equals(settlementId))
    .map(change => ({ status: change.status, at: change.at.toISOString() }));
}

describe('SettlementBook: the history of a settlement (request 19)', () => {
  it('a settlement in cash has one line: paid, when it was recorded', () => {
    const { book, settlementId } = recordedInCash();

    expect(storedLines(book, settlementId)).toEqual([{ status: 'paid', at: asked.toISOString() }]);
  });

  it('a payment through the provider that succeeds has pending, when asked, then paid, when Tally heard', () => {
    const { book, settlementId } = askedThroughProvider();
    book.receivePayment({ paymentId: 'prov-1', status: 'succeeded', at: heard });

    expect(storedLines(book, settlementId)).toEqual([
      { status: 'pending', at: asked.toISOString() },
      { status: 'paid', at: heard.toISOString() },
    ]);
  });

  it('a payment that fails has pending, then failed', () => {
    const { book, settlementId } = askedThroughProvider();
    book.receivePayment({ paymentId: 'prov-1', status: 'failed', at: heard });

    expect(storedLines(book, settlementId).map(line => line.status)).toEqual(['pending', 'failed']);
  });

  it('a refund of a paid settlement adds refunding, then refunded', () => {
    const { book, settlementId } = askedThroughProvider();
    book.receivePayment({ paymentId: 'prov-1', status: 'succeeded', at: heard });
    const proposal = book.proposeRefund({
      groupArchived: false,
      settlementId,
      caller: payee,
      members: ['payer', 'payee'],
    });
    if (proposal.isFailure()) throw new Error('the refund must be proposed');
    book.keepRefund(proposal.data, later);
    book.receivePayment({ paymentId: 'prov-1', status: 'refunded', at: later });

    expect(storedLines(book, settlementId)).toEqual([
      { status: 'pending', at: asked.toISOString() },
      { status: 'paid', at: heard.toISOString() },
      { status: 'refunding', at: later.toISOString() },
      { status: 'refunded', at: later.toISOString() },
    ]);
  });

  it('a refund that overtakes the success adds only refunded, the status it moves to', () => {
    const { book, settlementId } = askedThroughProvider();
    book.receivePayment({ paymentId: 'prov-1', status: 'refunded', at: heard });

    expect(storedLines(book, settlementId).map(line => line.status)).toEqual(['pending', 'refunded']);
  });

  it('a webhook that changes nothing adds no line', () => {
    const { book, settlementId } = askedThroughProvider();
    book.receivePayment({ paymentId: 'prov-1', status: 'succeeded', at: heard });
    book.receivePayment({ paymentId: 'prov-1', status: 'succeeded', at: later });
    book.receivePayment({ paymentId: 'prov-1', status: 'pending', at: later });
    book.receivePayment({ paymentId: 'prov-1', status: 'disputed', at: later });

    expect(storedLines(book, settlementId).map(line => line.status)).toEqual(['pending', 'paid']);
  });

  it('a settlement read from the store keeps its history, and a new status is added after it', () => {
    const { book, settlementId } = askedThroughProvider();
    book.receivePayment({ paymentId: 'prov-1', status: 'succeeded', at: heard });
    const [settlement] = book.unsaved;
    if (!settlement) throw new Error('the settlement must be kept');

    const reread = SettlementBook.open(book._id, 1, [{ ...settlement, history: [...settlement.history] }]);
    reread.receivePayment({ paymentId: 'prov-1', status: 'refunded', at: later });

    expect(reread.unsavedHistory).toEqual([{ settlementId, status: 'refunded', at: later }]);
    expect(reread.unsaved[0]?.history.map(line => line.status)).toEqual(['pending', 'paid', 'refunded']);
  });
});
