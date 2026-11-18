import { describe, expect, it } from '@jest/globals';

import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import {
  DuplicateTemplateMemberException,
  InvalidTemplateNameException,
  InvalidTemplateSharesException,
  NoTemplateMemberException,
  TemplateMemberNotInGroupException,
  TemplateNameTakenException,
} from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';

const now = new Date('2026-01-15T10:00:00.000Z');
const members = ['ann', 'bob', 'cy'];
const groupId = 'group-1';

const saved = (split: Parameters<typeof SplitTemplate.create>[0]['split'], name = 'Rent share') => {
  const result = SplitTemplate.create({ groupId, savedBy: 'ann', name, split }, members, undefined, now);
  if (result.isFailure()) throw new Error('the template should be saved');
  return result.data;
};

describe('a split template', () => {
  it('is saved with an equal split between members of the group, in the order given, one share each', () => {
    const template = saved({ kind: 'equal', memberIds: ['bob', 'ann'] });

    expect(template.splitDraft()).toEqual({ kind: 'equal', memberIds: ['bob', 'ann'] });
    expect(template.toSnapshot()).toMatchObject({
      groupId,
      name: 'Rent share',
      savedBy: 'ann',
      kind: 'equal',
      version: 0,
    });
  });

  it('is saved by shares, the shares kept as given', () => {
    const template = saved({
      kind: 'shares',
      shares: [
        { memberId: 'ann', shares: 2 },
        { memberId: 'bob', shares: 1 },
      ],
    });

    expect(template.toSnapshot().members).toEqual([
      { memberId: 'ann', shares: 2 },
      { memberId: 'bob', shares: 1 },
    ]);
  });

  it('has a name of 1 to 60 characters, not only spaces', () => {
    const split = { kind: 'equal' as const, memberIds: ['ann'] };
    const refused = (name: string) =>
      SplitTemplate.create({ groupId, savedBy: 'ann', name, split }, members, undefined, now);

    expect(refused('   ').error).toBeInstanceOf(InvalidTemplateNameException);
    expect(refused('x'.repeat(61)).error).toBeInstanceOf(InvalidTemplateNameException);
    expect(refused('x'.repeat(60)).isFailure()).toBe(false);
  });

  it('is refused when another template of the group holds its name, whatever its case', () => {
    const result = SplitTemplate.create(
      { groupId, savedBy: 'ann', name: 'RENT', split: { kind: 'equal', memberIds: ['ann'] } },
      members,
      'some-other-template',
      now,
    );

    expect(result.error).toBeInstanceOf(TemplateNameTakenException);
  });

  it('is refused for a member who is not in the group, one listed twice, none at all, or a share below 1', () => {
    expect(
      SplitTemplate.create(
        { groupId, savedBy: 'ann', name: 'A', split: { kind: 'equal', memberIds: ['ann', 'eve'] } },
        members,
        undefined,
        now,
      ).error,
    ).toBeInstanceOf(TemplateMemberNotInGroupException);
    expect(
      SplitTemplate.create(
        { groupId, savedBy: 'ann', name: 'A', split: { kind: 'equal', memberIds: ['ann', 'ann'] } },
        members,
        undefined,
        now,
      ).error,
    ).toBeInstanceOf(DuplicateTemplateMemberException);
    expect(
      SplitTemplate.create(
        { groupId, savedBy: 'ann', name: 'A', split: { kind: 'equal', memberIds: [] } },
        members,
        undefined,
        now,
      ).error,
    ).toBeInstanceOf(NoTemplateMemberException);
    expect(
      SplitTemplate.create(
        { groupId, savedBy: 'ann', name: 'A', split: { kind: 'shares', shares: [{ memberId: 'ann', shares: 0 }] } },
        members,
        undefined,
        now,
      ).error,
    ).toBeInstanceOf(InvalidTemplateSharesException);
  });

  it('is replaced under the same rules, and keeps its own name', () => {
    const template = saved({ kind: 'equal', memberIds: ['ann'] });
    const id = template.toSnapshot().id;

    expect(
      template
        .replace({ name: 'Rent share', split: { kind: 'equal', memberIds: ['bob'] } }, members, id, now)
        .isFailure(),
    ).toBe(false);
    expect(template.splitDraft()).toEqual({ kind: 'equal', memberIds: ['bob'] });
    expect(
      template.replace({ name: 'Other', split: { kind: 'equal', memberIds: ['bob'] } }, members, 'someone-else', now)
        .error,
    ).toBeInstanceOf(TemplateNameTakenException);
  });

  it('is kept as a snapshot and read back unchanged', () => {
    const template = saved({ kind: 'equal', memberIds: ['bob', 'ann'] });
    const snapshot = template.toSnapshot();

    expect(SplitTemplate.fromSnapshot(snapshot).toSnapshot()).toEqual(snapshot);
  });

  it('is refused as corrupted when a snapshot names no member', () => {
    expect(() =>
      SplitTemplate.fromSnapshot({
        id: 'x',
        groupId,
        name: 'Empty',
        savedBy: 'ann',
        kind: 'equal',
        members: [],
        version: 1,
      }),
    ).toThrow();
  });
});
