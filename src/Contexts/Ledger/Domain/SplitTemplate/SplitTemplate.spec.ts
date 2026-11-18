import { Id } from '@Architecture/Domain';

import {
  DuplicateSplitMember,
  InvalidShareCount,
  NotAMemberOfTheGroup,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import {
  TemplateRemovedEvent,
  TemplateReplacedEvent,
  TemplateSavedEvent,
} from '@Contexts/Ledger/Domain/SplitTemplate/Events/SplitTemplateEvents';
import {
  EmptyTemplateSplit,
  InvalidTemplateName,
  NotTheSaverOrTheOwner,
  TemplateNameTaken,
} from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';
import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';

const group = new Id('flat');
const ann = new Id('ann');
const ben = new Id('ben');
const members = [ann, ben];
const saved = (name = 'Flat') =>
  SplitTemplate.register({
    groupId: group,
    createdBy: ann,
    name,
    split: { kind: 'equal', members: ['ann', 'ben'] },
    groupMembers: members,
    nameTaken: false,
    archived: false,
  }).data as SplitTemplate;

describe('SplitTemplate', () => {
  it('is registered by a member under an id it generates, and records that it was saved', () => {
    const template = saved();

    expect(template._id.value).toEqual(expect.any(String));
    expect(template.toSnapshot()).toMatchObject({
      groupId: 'flat',
      name: 'Flat',
      createdBy: 'ann',
      split: { kind: 'equal', members: ['ann', 'ben'] },
      version: 0,
    });
    expect(template.pullDomainEvents()).toEqual([
      TemplateSavedEvent.set({ templateId: template._id.value, groupId: 'flat' }),
    ]);
  });

  it('keeps a split by shares as it was given', () => {
    const template = SplitTemplate.register({
      groupId: group,
      createdBy: ben,
      name: 'Big room',
      split: {
        kind: 'shares',
        shares: [
          { memberId: 'ann', shares: 2 },
          { memberId: 'ben', shares: 1 },
        ],
      },
      groupMembers: members,
      nameTaken: false,
      archived: false,
    }).data as SplitTemplate;

    expect(template.split).toEqual({
      kind: 'shares',
      shares: [
        { memberId: 'ann', shares: 2 },
        { memberId: 'ben', shares: 1 },
      ],
    });
  });

  it('has a name of 1 to 60 characters, not only spaces, and a name free in its group', () => {
    const split = { kind: 'equal' as const, members: ['ann'] };
    const attempt = (name: string, nameTaken = false) =>
      SplitTemplate.register({
        groupId: group,
        createdBy: ann,
        name,
        split,
        groupMembers: members,
        nameTaken,
        archived: false,
      });

    expect(attempt('   ').error).toBeInstanceOf(InvalidTemplateName);
    expect(attempt('x'.repeat(61)).error).toBeInstanceOf(InvalidTemplateName);
    expect(attempt('x'.repeat(60)).isSuccess()).toBe(true);
    expect(attempt('Rent', true).error).toBeInstanceOf(TemplateNameTaken);
  });

  it('splits between members listed once, each a member of the group, and by shares of at least 1', () => {
    const register = (split: Parameters<typeof SplitTemplate.register>[0]['split']) =>
      SplitTemplate.register({
        groupId: group,
        createdBy: ann,
        name: 'T',
        split,
        groupMembers: members,
        nameTaken: false,
        archived: false,
      });

    expect(register({ kind: 'equal', members: [] }).error).toBeInstanceOf(EmptyTemplateSplit);
    expect(register({ kind: 'equal', members: ['ann', 'ann'] }).error).toBeInstanceOf(DuplicateSplitMember);
    expect(register({ kind: 'equal', members: ['ann', 'cy'] }).error).toBeInstanceOf(NotAMemberOfTheGroup);
    expect(register({ kind: 'shares', shares: [{ memberId: 'ann', shares: 0 }] }).error).toBeInstanceOf(
      InvalidShareCount,
    );
  });

  it('is replaced by its saver or the owner, keeping its saver, and records that it was replaced', () => {
    const template = saved();
    const replaced = template.replaceWith({
      by: ben,
      byOwner: false,
      name: 'Flat',
      split: { kind: 'equal', members: ['ben'] },
      groupMembers: members,
      nameTaken: false,
      archived: false,
    });

    expect(replaced.error).toBeInstanceOf(NotTheSaverOrTheOwner);
    const byOwner = template.replaceWith({
      by: ben,
      byOwner: true,
      name: 'Ben',
      split: { kind: 'equal', members: ['ben'] },
      groupMembers: members,
      nameTaken: false,
      archived: false,
    }).data as SplitTemplate;
    expect(byOwner.toSnapshot()).toMatchObject({ name: 'Ben', createdBy: 'ann', version: 0 });
    expect(byOwner.pullDomainEvents()).toEqual([
      TemplateReplacedEvent.set({ templateId: template._id.value, groupId: 'flat' }),
    ]);
  });

  it('is removed by its saver or the owner, and records that it was removed', () => {
    const template = saved();

    expect(template.remove({ by: ben, byOwner: false, archived: false }).error).toBeInstanceOf(NotTheSaverOrTheOwner);
    expect(template.remove({ by: ann, byOwner: false, archived: false }).isSuccess()).toBe(true);
    expect(template.pullDomainEvents()).toEqual([
      TemplateSavedEvent.set({ templateId: template._id.value, groupId: 'flat' }),
      TemplateRemovedEvent.set({ templateId: template._id.value, groupId: 'flat' }),
    ]);
  });

  it('is rebuilt from its snapshot, recording nothing', () => {
    const template = saved();
    const snapshot = template.toSnapshot();

    expect(SplitTemplate.fromSnapshot(snapshot).toSnapshot()).toEqual(snapshot);
    expect(SplitTemplate.fromSnapshot(snapshot).pullDomainEvents()).toEqual([]);
  });
});
