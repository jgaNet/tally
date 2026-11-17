import { describe, expect, it } from '@jest/globals';

import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';

describe('ScryptPasswordHasher', () => {
  const hasher = new ScryptPasswordHasher();

  it('checks the password it made the hash of, and no other', async () => {
    const hash = await hasher.hash('the right one');
    expect(await hasher.matches('the right one', hash)).toBe(true);
    expect(await hasher.matches('the wrong one', hash)).toBe(false);
  });

  it('salts each hash, so two accounts with one password do not share a hash', async () => {
    expect(await hasher.hash('same')).not.toEqual(await hasher.hash('same'));
  });

  it('proves no password against a value it does not read as a hash', async () => {
    expect(await hasher.matches('anything', 'plain text')).toBe(false);
  });
});
