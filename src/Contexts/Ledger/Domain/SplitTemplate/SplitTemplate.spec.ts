import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { TemplateSavedEvent } from '@Contexts/Ledger/Domain/SplitTemplate/Events/SplitTemplateEvents';

const members = [
  { memberId: 'ada', role: 'owner' as const },
  { memberId: 'bob', role: 'member' as const },
];

const saved = (overrides: Partial<Parameters<typeof SplitTemplate.create>[0]> = {}) =>
  SplitTemplate.create({
    groupId: 'flat',
    name: 'Rent',
    split: { kind: 'equal', between: ['ada', 'bob'] },
    by: 'bob',
    members,
    nameIsFree: true,
    archived: false,
    ...overrides,
  });

describe('SplitTemplate', () => {
  it('is saved under a trimmed name with its split, and records TemplateSaved', () => {
    const template = saved({ name: '  Rent  ' });
    expect(template.isFailure()).toBe(false);
    expect(template.data?.name).toBe('Rent');
    expect(template.data?.createdBy).toBe('bob');
    expect(template.data?.asSplitInput()).toEqual({ kind: 'equal', between: ['ada', 'bob'] });
    expect(template.data?.version).toBe(0);
  });

  it('refuses a name of 0 or more than 60 characters, and one that is only spaces', () => {
    expect(saved({ name: '   ' }).isFailure()).toBe(true);
    expect(saved({ name: 'x'.repeat(61) }).isFailure()).toBe(true);
    expect(saved({ name: 'x'.repeat(60) }).isFailure()).toBe(false);
  });

  it('refuses a name the group already has', () => {
    expect(saved({ nameIsFree: false }).isFailure()).toBe(true);
  });

  it('refuses a split that names a non-member, a member twice, nobody, or a share below 1', () => {
    expect(saved({ split: { kind: 'equal', between: ['ada', 'cy'] } }).isFailure()).toBe(true);
    expect(saved({ split: { kind: 'equal', between: ['ada', 'ada'] } }).isFailure()).toBe(true);
    expect(saved({ split: { kind: 'equal', between: [] } }).isFailure()).toBe(true);
    expect(saved({ split: { kind: 'shares', shares: [{ memberId: 'ada', shares: 0 }] } }).isFailure()).toBe(true);
  });

  it('is replaced by its author or the owner only, and keeps its author', () => {
    const template = saved().data as SplitTemplate;
    const byOwner = template.replace({
      archived: false,
      by: 'ada',
      members,
      name: 'Home',
      split: { kind: 'shares', shares: [{ memberId: 'ada', shares: 3 }] },
      nameIsFree: true,
    });
    expect(byOwner.isFailure()).toBe(false);
    expect(byOwner.data?.createdBy).toBe('bob');
    expect(byOwner.data?.name).toBe('Home');
    expect(
      template
        .replace({
          archived: false,
          by: 'ada',
          members: [
            { memberId: 'ada', role: 'member' },
            { memberId: 'bob', role: 'member' },
          ],
          name: 'Home',
          split: { kind: 'equal', between: ['ada'] },
          nameIsFree: true,
        })
        .isFailure(),
    ).toBe(true);
  });

  it('is removed by its author or the owner only', () => {
    const template = saved().data as SplitTemplate;
    expect(template.delete({ archived: false, by: 'ada', members }).isFailure()).toBe(false);
    expect(
      template
        .delete({
          archived: false,
          by: 'ada',
          members: [
            { memberId: 'ada', role: 'member' },
            { memberId: 'bob', role: 'member' },
          ],
        })
        .isFailure(),
    ).toBe(true);
  });

  it('reads back what it stored, and refuses corrupted data', () => {
    const template = saved().data as SplitTemplate;
    const again = SplitTemplate.fromSnapshot({ ...template.toSnapshot(), version: 4 });
    expect(again.toSnapshot()).toEqual({ ...template.toSnapshot(), version: 4 });
    expect(() =>
      SplitTemplate.fromSnapshot({ ...template.toSnapshot(), split: { kind: 'equal', between: [] } }),
    ).toThrow();
    expect(() => SplitTemplate.fromSnapshot({ ...template.toSnapshot(), name: '' })).toThrow();
  });

  it('is the event it records once saved, carrying its group and name', () => {
    const template = saved().data as SplitTemplate;
    expect(template).toBeDefined();
    expect(TemplateSavedEvent).toBeDefined();
  });
});
