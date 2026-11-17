import { describe, expect, it } from '@jest/globals';

import { SignedSessionTokens } from '@Contexts/Groups/Infrastructure/SignedSessionTokens';

describe('SignedSessionTokens', () => {
  const tokens = new SignedSessionTokens('a key');

  it('proves the account it was issued for', () => {
    const token = tokens.issue('6f1c0a52-0000-4000-8000-000000000001');
    expect(tokens.accountOf(token)).toBe('6f1c0a52-0000-4000-8000-000000000001');
  });

  it('proves nothing once altered, or signed with another key', () => {
    const [payload, signature] = tokens.issue('account-1').split('.');
    const forged = Buffer.from('account-2').toString('base64url');

    expect(tokens.accountOf(`${forged}.${signature}`)).toBeUndefined();
    expect(tokens.accountOf(`${payload}.${signature}x`)).toBeUndefined();
    expect(tokens.accountOf(`${payload}.`)).toBeUndefined();
    expect(new SignedSessionTokens('another key').accountOf(tokens.issue('account-1'))).toBeUndefined();
    expect(tokens.accountOf('garbage')).toBeUndefined();
  });
});
