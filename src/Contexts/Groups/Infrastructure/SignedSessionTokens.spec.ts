import { createHmac } from 'crypto';

import { describe, expect, it } from '@jest/globals';

import { SignedSessionTokens } from '@Contexts/Groups/Infrastructure/SignedSessionTokens';
import { Role } from '@SharedKernel/Domain';

describe('SignedSessionTokens', () => {
  const tokens = new SignedSessionTokens('a key');

  it('proves the account it was issued for', () => {
    const token = tokens.issue('6f1c0a52-0000-4000-8000-000000000001');
    expect(tokens.accountOf(token)).toBe('6f1c0a52-0000-4000-8000-000000000001');
  });

  it('proves a user unless it was issued as an administrator (request 33)', () => {
    expect(tokens.roleOf(tokens.issue('account-1'))).toBe(Role.USER);
    expect(tokens.roleOf(tokens.issue('account-1', Role.ADMIN))).toBe(Role.ADMIN);
    expect(tokens.accountOf(tokens.issue('account-1', Role.ADMIN))).toBe('account-1');
  });

  it('still proves the account of a token an earlier server signed, the bare account id, as a user', () => {
    const payload = Buffer.from('account-9').toString('base64url');
    const signature = createHmac('sha256', 'a key').update(payload).digest('base64url');

    expect(tokens.accountOf(`${payload}.${signature}`)).toBe('account-9');
    expect(tokens.roleOf(`${payload}.${signature}`)).toBe(Role.USER);
  });

  it('proves nothing once altered, or signed with another key', () => {
    const [payload, signature] = tokens.issue('account-1').split('.');
    const forged = Buffer.from(JSON.stringify({ accountId: 'account-2', role: 'ADMIN' })).toString('base64url');

    expect(tokens.accountOf(`${forged}.${signature}`)).toBeUndefined();
    expect(tokens.accountOf(`${payload}.${signature}x`)).toBeUndefined();
    expect(tokens.accountOf(`${payload}.`)).toBeUndefined();
    expect(new SignedSessionTokens('another key').accountOf(tokens.issue('account-1'))).toBeUndefined();
    expect(tokens.accountOf('garbage')).toBeUndefined();
  });
});
