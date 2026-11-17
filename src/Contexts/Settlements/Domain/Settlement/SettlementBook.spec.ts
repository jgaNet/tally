import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

const at = new Date('2026-11-17T10:00:00.000Z');
const book = (version = 0) => SettlementBook.fromSnapshot({ groupId: 'group-1', version });

/** Ann (the payee) records 30 paid by Bob (the payer): Bob owes 30, Ann is owed 30, and both are members. */
const cash = (overrides: Partial<Parameters<SettlementBook['recordCash']>[0]> = {}) => ({
  by: 'ann',
  from: 'bob',
  amount: 30,
  members: ['ann', 'bob', 'cy'],
  balances: { payer: -30, payee: 30 },
  at,
  ...overrides,
});

describe('a settlement book', () => {
  it('is at version 0 with no settlement when no settlement of the group is stored', () => {
    const empty = book();
    expect(empty.groupId).toBe('group-1');
    expect(empty.version).toBe(0);
    expect(empty.recorded).toEqual([]);
  });

  it('refuses a snapshot that is corrupted', () => {
    expect(() => SettlementBook.fromSnapshot({ groupId: 'group-1', version: -1 })).toThrow();
    expect(() => SettlementBook.fromSnapshot({ groupId: '', version: 0 })).toThrow();
  });

  it('records a cash settlement from the payer to the payee, paid, at the time given', () => {
    const recorded = book().recordCash(cash());
    expect(recorded.isFailure()).toBe(false);
    expect(recorded.data).toEqual({
      id: expect.any(String),
      groupId: 'group-1',
      from: 'bob',
      to: 'ann',
      amount: 30,
      method: 'cash',
      status: 'paid',
      at: '2026-11-17T10:00:00.000Z',
    });
  });

  it('records SettlementRecorded once it is recorded, and nothing when it is refused', () => {
    const settled = book();
    settled.recordCash(cash());
    expect(settled.pullDomainEvents()).toHaveLength(1);

    const refused = book();
    refused.recordCash(cash({ amount: 31 }));
    expect(refused.pullDomainEvents()).toHaveLength(0);
    expect(refused.recorded).toEqual([]);
  });

  it('allows an amount that is exactly what the payer owes and what the payee is owed', () => {
    expect(
      book()
        .recordCash(cash({ amount: 30 }))
        .isFailure(),
    ).toBe(false);
  });

  it('refuses more than the payer owes', () => {
    const refused = book().recordCash(cash({ amount: 31, balances: { payer: -30, payee: 50 } }));
    expect(refused.isFailure()).toBe(true);
    expect(refused.error).toMatchObject({ type: 'SettlementExceedsDebt' });
  });

  it('refuses more than the payee is owed', () => {
    const refused = book().recordCash(cash({ amount: 31, balances: { payer: -50, payee: 30 } }));
    expect(refused.isFailure()).toBe(true);
    expect(refused.error).toMatchObject({ type: 'SettlementExceedsDebt' });
  });

  it('refuses a payer who owes nothing, though the payee is owed', () => {
    const refused = book().recordCash(cash({ balances: { payer: 5, payee: 30 } }));
    expect(refused.isFailure()).toBe(true);
    expect(refused.error).toMatchObject({ type: 'SettlementExceedsDebt' });
  });

  it('refuses an amount that is not a whole number of at least 1', () => {
    for (const amount of [0, -5, 1.5]) {
      const refused = book().recordCash(cash({ amount }));
      expect(refused.isFailure()).toBe(true);
      expect(refused.error).toMatchObject({ type: 'InvalidSettlementAmount' });
    }
  });

  it('refuses a payer who is not a member of the group', () => {
    const refused = book().recordCash(cash({ from: 'dan' }));
    expect(refused.isFailure()).toBe(true);
    expect(refused.error).toMatchObject({ type: 'NotFound' });
  });

  it('refuses a member paying itself', () => {
    const refused = book().recordCash(cash({ from: 'ann', by: 'ann' }));
    expect(refused.isFailure()).toBe(true);
    expect(refused.error).toMatchObject({ type: 'SettlementToSelf' });
  });

  it('gives each settlement its own id', () => {
    const settled = book();
    const ids = [settled.recordCash(cash({ amount: 10 })), settled.recordCash(cash({ amount: 10 }))].map(
      r => r.data?.id,
    );
    expect(ids[0]).toEqual(expect.any(String));
    expect(ids[0]).not.toBe(ids[1]);
    expect(settled.recorded.map(each => each.id)).toEqual(ids);
  });
});
