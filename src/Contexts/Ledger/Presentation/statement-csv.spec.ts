import { describe, expect, it } from '@jest/globals';

import { csvField, statementAsCsv } from '@Contexts/Ledger/Presentation/statement-csv';

/** The statement as CSV (request 29): the quoting of a field is the RFC 4180 one, and the lines are CRLF ended. */
describe('statementAsCsv', () => {
  it('quotes a field holding a comma, a double quote or a line break, doubling the quotes, and no other', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField(-500)).toBe('-500');
    expect(csvField('a, b')).toBe('"a, b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it('writes the header and one CRLF-ended line for each entry, in order, the id of an expense or of a settlement', () => {
    const text = statementAsCsv({
      memberId: 'm',
      balance: 0,
      entries: [
        { kind: 'expense', expenseId: 'e1', date: '2020-01-10', description: 'x', paid: 100, share: 0, balance: 100 },
        {
          kind: 'settlement',
          settlementId: 's1',
          date: '2020-01-11',
          description: 'Settlement in cash',
          paid: 0,
          share: 100,
          balance: 0,
        },
      ],
    });
    expect(text).toBe(
      'date,kind,id,description,paid,share,balance\r\n' +
        '2020-01-10,expense,e1,x,100,0,100\r\n' +
        '2020-01-11,settlement,s1,Settlement in cash,0,100,0\r\n',
    );
  });
});
