import { renderStatementCsv } from '@Contexts/Ledger/Presentation/API/REST/Controllers/StatementCsv';

describe('a statement as CSV (request 29)', () => {
  it('is the header alone for an empty statement, with CRLF', () => {
    expect(renderStatementCsv({ memberId: 'm', balance: 0, entries: [] })).toBe(
      'date,kind,id,description,paid,share,balance\r\n',
    );
  });

  it('writes one line per entry, its id being the expense or the settlement, and quotes only the fields that need it', () => {
    const text = renderStatementCsv({
      memberId: 'm',
      balance: 50,
      entries: [
        {
          kind: 'expense',
          expenseId: 'e1',
          date: '2026-03-10',
          description: 'Pizza, "large"',
          paid: 300,
          share: 150,
          balance: 150,
        },
        {
          kind: 'settlement',
          settlementId: 's1',
          date: '2026-03-11',
          description: 'Settlement in cash',
          paid: 0,
          share: 100,
          balance: 50,
        },
        {
          kind: 'expense',
          expenseId: 'e2',
          date: '2026-03-12',
          description: 'Two\nlines',
          paid: 0,
          share: 0,
          balance: 50,
        },
      ],
    });
    expect(text).toBe(
      [
        'date,kind,id,description,paid,share,balance',
        '2026-03-10,expense,e1,"Pizza, ""large""",300,150,150',
        '2026-03-11,settlement,s1,Settlement in cash,0,100,50',
        '2026-03-12,expense,e2,"Two\nlines",0,0,50',
        '',
      ].join('\r\n'),
    );
  });

  it('writes a negative balance as it is, and quotes a field holding a carriage return', () => {
    const text = renderStatementCsv({
      memberId: 'm',
      balance: -20,
      entries: [
        { kind: 'expense', expenseId: 'e', date: '2026-03-10', description: 'a\rb', paid: 0, share: 20, balance: -20 },
      ],
    });
    expect(text.split('\r\n')).toEqual([
      'date,kind,id,description,paid,share,balance',
      '2026-03-10,expense,e,"a\rb",0,20,-20',
      '',
    ]);
  });
});
