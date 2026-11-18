import { statementAsCsv } from './statementAsCsv';

/** The statement as CSV (request 29): the header, then CRLF after every line, and quotes only where a field needs them. */
describe('a statement as CSV (request 29)', () => {
  it('writes the header alone for an empty statement, with CRLF', () => {
    expect(statementAsCsv({ memberId: 'ada', balance: 0, entries: [] })).toBe(
      'date,kind,id,description,paid,share,balance\r\n',
    );
  });

  it('quotes a field holding a comma, a double quote or a line break, doubling its double quotes, and no other', () => {
    const csv = statementAsCsv({
      memberId: 'ada',
      balance: -5,
      entries: [
        {
          kind: 'expense',
          expenseId: 'e1',
          date: '2025-01-02',
          description: 'a, "b"\nc',
          paid: 0,
          share: 5,
          balance: -5,
        },
        {
          kind: 'settlement',
          settlementId: 's1',
          date: '2025-01-03',
          description: 'Settlement in cash',
          paid: 0,
          share: 0,
          balance: -5,
        },
      ],
    });

    expect(csv).toBe(
      'date,kind,id,description,paid,share,balance\r\n' +
        '2025-01-02,expense,e1,"a, ""b""\nc",0,5,-5\r\n' +
        '2025-01-03,settlement,s1,Settlement in cash,0,0,-5\r\n',
    );
  });
});
