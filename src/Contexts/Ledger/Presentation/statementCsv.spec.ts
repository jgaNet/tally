import { StatementView } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { statementAsCsv, STATEMENT_CSV_HEADER } from '@Contexts/Ledger/Presentation/statementCsv';

describe('the statement as CSV (request 29)', () => {
  it('answers the header alone for a statement with no entry, CRLF ended', () => {
    const statement: StatementView = { memberId: 'ann', balance: 0, entries: [] };
    expect(statementAsCsv(statement)).toBe(`${STATEMENT_CSV_HEADER}\r\n`);
    expect(STATEMENT_CSV_HEADER).toBe('date,kind,id,description,paid,share,balance');
  });

  it('writes an expense by its expense id and a settlement by its settlement id, quoting only the fields with a comma, a quote or a line break', () => {
    const statement: StatementView = {
      memberId: 'ann',
      balance: 300,
      entries: [
        {
          kind: 'expense',
          expenseId: 'e1',
          date: '2026-01-02',
          description: 'Lunch, "fancy"',
          paid: 900,
          share: 300,
          balance: 600,
        },
        {
          kind: 'settlement',
          settlementId: 's1',
          date: '2026-01-03',
          description: 'Settlement in cash',
          paid: 0,
          share: 300,
          balance: 300,
        },
        {
          kind: 'expense',
          expenseId: 'e2',
          date: '2026-01-04',
          description: 'two\nlines',
          paid: 0,
          share: 0,
          balance: 300,
        },
      ],
    };
    expect(statementAsCsv(statement)).toBe(
      [
        'date,kind,id,description,paid,share,balance',
        '2026-01-02,expense,e1,"Lunch, ""fancy""",900,300,600',
        '2026-01-03,settlement,s1,Settlement in cash,0,300,300',
        '2026-01-04,expense,e2,"two\nlines",0,0,300',
        '',
      ].join('\r\n'),
    );
  });
});
