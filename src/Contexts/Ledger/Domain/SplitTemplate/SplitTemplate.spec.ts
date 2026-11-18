import { Id } from '@Architecture/Domain';
import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { TemplateName } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateName';
import { templateSplitOf } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';

const at = new Date('2026-11-01T10:00:00Z');
const ann = new Id('00000000-0000-4000-8000-00000000000a');
const bob = new Id('00000000-0000-4000-8000-00000000000b');
const cy = new Id('00000000-0000-4000-8000-00000000000c');
const group = new Id('00000000-0000-4000-8000-0000000000aa');

function name(raw: string) {
  const result = TemplateName.of(raw);
  if (result.isFailure()) throw new Error('a name the test needs');
  return result.data;
}

function split(members: Id[]) {
  const result = templateSplitOf({ splitBetween: members.map(member => member.value) });
  if (result.isFailure()) throw new Error('a split the test needs');
  return result.data;
}

describe('TemplateName', () => {
  it('is 1 to 60 characters, not only spaces', () => {
    expect(TemplateName.of('').isFailure()).toBe(true);
    expect(TemplateName.of('   ').isFailure()).toBe(true);
    expect(TemplateName.of('a'.repeat(60)).isSuccess()).toBe(true);
    expect(TemplateName.of('a'.repeat(61)).isFailure()).toBe(true);
  });

  it('compares names whatever their case', () => {
    expect(name('Big Room').key).toBe(name('big room').key);
  });
});

describe('templateSplitOf', () => {
  it('refuses both splits or neither, and an empty list', () => {
    expect(templateSplitOf({}).isFailure()).toBe(true);
    expect(
      templateSplitOf({ splitBetween: [ann.value], splitByShares: [{ memberId: ann.value, shares: 1 }] }).isFailure(),
    ).toBe(true);
    expect(templateSplitOf({ splitBetween: [] }).isFailure()).toBe(true);
  });

  it('refuses a member listed twice and shares below 1', () => {
    expect(templateSplitOf({ splitBetween: [ann.value, ann.value] }).isFailure()).toBe(true);
    expect(templateSplitOf({ splitByShares: [{ memberId: ann.value, shares: 0 }] }).isFailure()).toBe(true);
  });
});

describe('SplitTemplate', () => {
  it('is saved when its members are members of the group and its name is free', () => {
    const saved = SplitTemplate.draft({
      groupId: group,
      name: name('Flat'),
      split: split([ann, bob]),
      savedBy: ann,
      groupMembers: [ann, bob],
      sameNameAs: null,
      groupArchived: false,
      at,
    });
    expect(saved.isSuccess()).toBe(true);
    expect(saved.data?.toSnapshot().version).toBe(0);
  });

  it('refuses a name another template holds, and a member who is not in the group', () => {
    const taken = SplitTemplate.draft({
      groupId: group,
      name: name('Flat'),
      split: split([ann]),
      savedBy: ann,
      groupMembers: [ann],
      sameNameAs: bob,
      groupArchived: false,
      at,
    });
    expect(taken.isFailure()).toBe(true);

    const outsider = SplitTemplate.draft({
      groupId: group,
      name: name('Flat'),
      split: split([ann, cy]),
      savedBy: ann,
      groupMembers: [ann, bob],
      sameNameAs: null,
      groupArchived: false,
      at,
    });
    expect(outsider.isFailure()).toBe(true);
  });

  it('is refused by GroupArchived in an archived group, and nothing is saved, revised or removed', () => {
    const refused = SplitTemplate.draft({
      groupId: group,
      name: name('Flat'),
      split: split([ann]),
      savedBy: ann,
      groupMembers: [ann, bob],
      sameNameAs: null,
      groupArchived: true,
      at,
    });
    expect(refused.isFailure()).toBe(true);
    expect(refused.isFailure() && refused.error.type).toBe('GroupArchived');

    const saved = SplitTemplate.draft({
      groupId: group,
      name: name('Flat'),
      split: split([ann]),
      savedBy: ann,
      groupMembers: [ann, bob],
      sameNameAs: null,
      groupArchived: false,
      at,
    });
    const template = saved.data as SplitTemplate;

    const revised = template.revise({
      by: ann,
      byOwner: true,
      name: name('Other'),
      split: split([ann]),
      groupMembers: [ann, bob],
      sameNameAs: null,
      groupArchived: true,
      at,
    });
    expect(revised.isFailure()).toBe(true);
    expect(revised.isFailure() && revised.error.type).toBe('GroupArchived');
    expect(template.name.key).toBe(name('Flat').key);

    const retired = template.retire({ by: ann, byOwner: true, groupArchived: true, at });
    expect(retired.isFailure()).toBe(true);
    expect(retired.isFailure() && retired.error.type).toBe('GroupArchived');
    expect(template.isRemoved).toBe(false);
  });

  it('may be revised or retired only by the member who saved it or the owner', () => {
    const saved = SplitTemplate.draft({
      groupId: group,
      name: name('Flat'),
      split: split([ann]),
      savedBy: ann,
      groupMembers: [ann, bob],
      sameNameAs: null,
      groupArchived: false,
      at,
    });
    const template = saved.data as SplitTemplate;

    const byBob = template.revise({
      by: bob,
      byOwner: false,
      name: name('Flat'),
      split: split([bob]),
      groupMembers: [ann, bob],
      sameNameAs: null,
      groupArchived: false,
      at,
    });
    expect(byBob.isFailure()).toBe(true);
    expect(template.retire({ by: bob, byOwner: false, groupArchived: false, at }).isFailure()).toBe(true);

    const byOwner = template.retire({ by: bob, byOwner: true, groupArchived: false, at });
    expect(byOwner.isSuccess()).toBe(true);
    expect(byOwner.data?.isRemoved).toBe(true);
  });

  it('reads back what it stores', () => {
    const template = SplitTemplate.fromSnapshot({
      id: ann.value,
      groupId: group.value,
      name: 'Flat',
      savedBy: ann.value,
      kind: 'shares',
      members: [{ memberId: ann.value, shares: 2 }],
      version: 3,
    });
    expect(template.toSnapshot()).toMatchObject({
      kind: 'shares',
      version: 3,
      members: [{ memberId: ann.value, shares: 2 }],
    });
    expect(template.asSplitRequest()).toEqual({ splitByShares: [{ memberId: ann.value, shares: 2 }] });
  });
});
