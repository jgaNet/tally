import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** Split templates (request 25): who may save, replace and remove one, and which splits and names it refuses. */
const members: GroupMember[] = [
  { memberId: 'ana', role: 'owner' },
  { memberId: 'ben', role: 'member' },
  { memberId: 'cy', role: 'member' },
];

/** The template of a Result that succeeded: the spec asserts it succeeded before it reads it. */
const okOf = (result: { data?: SplitTemplate }): SplitTemplate => result.data as SplitTemplate;

const draftOf = (overrides: Partial<Parameters<typeof SplitTemplate.draft>[0]> = {}) =>
  SplitTemplate.draft({
    groupId: 'flat',
    name: 'Flat',
    split: { kind: 'equal', memberIds: ['ana', 'ben'] },
    savedBy: 'ben',
    members,
    nameTaken: false,
    ...overrides,
  });

describe('SplitTemplate.draft', () => {
  it('keeps a split of members of the group, each listed once, with at least one share', () => {
    const drafted = draftOf({
      split: {
        kind: 'shares',
        shares: [
          { memberId: 'ana', shares: 2 },
          { memberId: 'cy', shares: 1 },
        ],
      },
    });
    expect(drafted.isFailure()).toBe(false);
    expect(okOf(drafted).toSnapshot().split).toEqual({
      kind: 'shares',
      shares: [
        { memberId: 'ana', shares: 2 },
        { memberId: 'cy', shares: 1 },
      ],
    });
  });

  it('refuses a name that is only spaces, or longer than 60 characters', () => {
    expect(draftOf({ name: '   ' }).error?.type).toBe('InvalidTemplateName');
    expect(draftOf({ name: 'x'.repeat(61) }).error?.type).toBe('InvalidTemplateName');
    expect(draftOf({ name: 'x'.repeat(60) }).isFailure()).toBe(false);
  });

  it('refuses a name another template of the group has', () => {
    expect(draftOf({ nameTaken: true }).error?.type).toBe('DuplicateTemplateName');
  });

  it('refuses a member who is not in the group, and one listed twice', () => {
    expect(draftOf({ split: { kind: 'equal', memberIds: ['ana', 'zed'] } }).error?.type).toBe('SplitWithStranger');
    expect(draftOf({ split: { kind: 'equal', memberIds: ['ana', 'ana'] } }).error?.type).toBe('SplitListsTwice');
  });

  it('refuses a share that is not a whole number of at least 1', () => {
    expect(draftOf({ split: { kind: 'shares', shares: [{ memberId: 'ana', shares: 0 }] } }).error?.type).toBe(
      'InvalidShares',
    );
  });

  it('records TemplateSaved once, with the template', () => {
    const drafted = draftOf();
    const events = okOf(drafted).pullDomainEvents();
    expect(events.map(event => event.name)).toEqual(['TemplateSavedEvent']);
  });
});

describe('SplitTemplate change and removal', () => {
  const saved = okOf(draftOf());

  it('lets the member who saved it replace it, keeping its group and saver', () => {
    const replaced = saved.replace({
      replacedBy: 'ben',
      members,
      name: 'Flat, new',
      split: { kind: 'equal', memberIds: ['ana', 'cy'] },
      nameTaken: false,
    });
    expect(replaced.isFailure()).toBe(false);
    expect(okOf(replaced).toSnapshot()).toMatchObject({ groupId: 'flat', name: 'Flat, new', savedBy: 'ben' });
  });

  it('lets the owner replace or remove it', () => {
    expect(
      saved
        .replace({
          replacedBy: 'ana',
          members,
          name: 'Flat',
          split: { kind: 'equal', memberIds: ['ana'] },
          nameTaken: false,
        })
        .isFailure(),
    ).toBe(false);
    expect(saved.remove({ removedBy: 'ana', members }).isFailure()).toBe(false);
  });

  it('refuses any other member, to replace or to remove it', () => {
    expect(saved.remove({ removedBy: 'cy', members }).error?.type).toBe('NotAllowed');
    expect(
      saved.replace({
        replacedBy: 'cy',
        members,
        name: 'Flat',
        split: { kind: 'equal', memberIds: ['cy'] },
        nameTaken: false,
      }).error?.type,
    ).toBe('NotAllowed');
  });
});
