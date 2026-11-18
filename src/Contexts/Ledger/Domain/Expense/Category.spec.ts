import { CATEGORIES, Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { InvalidCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

describe('Category', () => {
  it('is one of the eight, in their order', () => {
    expect(CATEGORIES).toEqual(['groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other']);
    for (const name of CATEGORIES) expect(Category.create(name).data?.value).toBe(name);
  });

  it('is other when none is given, and refuses any other word', () => {
    expect(Category.create().data?.value).toBe('other');
    expect(Category.create(null).data?.value).toBe('other');
    for (const word of ['', 'Groceries', 'pets']) expect(Category.create(word).error).toBeInstanceOf(InvalidCategory);
  });

  it('throws when it is restored from a word that is not one', () => {
    expect(() => Category.restore('pets')).toThrow();
  });
});
