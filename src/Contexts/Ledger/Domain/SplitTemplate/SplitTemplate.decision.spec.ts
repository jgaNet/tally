import { SplitTemplateSnapshot, TemplateSplit } from './SplitTemplate';
import { decideRemoveTemplate, decideReplaceTemplate, decideSaveTemplate } from './SplitTemplate.decision';

const now = new Date('2026-11-18T10:00:00Z');
const members = ['ada', 'grace', 'linus'];
const ownerId = 'ada';

const equal = (...memberIds: string[]): TemplateSplit => ({ kind: 'equal', memberIds });
const byShares = (...shares: [string, number][]): TemplateSplit => ({
  kind: 'shares',
  shares: shares.map(([memberId, count]) => ({ memberId, shares: count })),
});

const stored = (overrides: Partial<SplitTemplateSnapshot> = {}): SplitTemplateSnapshot => ({
  id: 'template-1',
  groupId: 'group-1',
  name: 'Flat',
  split: equal('ada', 'grace'),
  savedBy: 'grace',
  version: 1,
  ...overrides,
});

describe('saving a template', () => {
  it('lets a member save a split by equal members or by shares, under a name trimmed of its spaces', () => {
    const byEqual = decideSaveTemplate(
      { memberIds: members, nameTaken: false },
      { by: 'grace', name: '  Flat  ', split: equal('ada', 'grace') },
      now,
    );
    expect(byEqual.isSuccess()).toBe(true);
    expect(byEqual.data!.state.name.value).toBe('Flat');

    const byShareCount = decideSaveTemplate(
      { memberIds: members, nameTaken: false },
      { by: 'grace', name: 'Big room', split: byShares(['ada', 2], ['grace', 1]) },
      now,
    );
    expect(byShareCount.isSuccess()).toBe(true);
  });

  it('refuses a name that is blank, or of more than 60 characters', () => {
    for (const name of ['', '   ', 'x'.repeat(61)]) {
      const decision = decideSaveTemplate(
        { memberIds: members, nameTaken: false },
        { by: 'grace', name, split: equal('ada') },
        now,
      );
      expect(decision.error!.type).toBe('InvalidTemplateName');
    }
  });

  it('refuses a name another template of the group has', () => {
    const decision = decideSaveTemplate(
      { memberIds: members, nameTaken: true },
      { by: 'grace', name: 'FLAT', split: equal('ada') },
      now,
    );
    expect(decision.error!.type).toBe('TemplateNameTaken');
  });

  it('refuses a split with a member who is not in the group, one listed twice, none, or a share below 1', () => {
    const access = { memberIds: members, nameTaken: false };
    expect(
      decideSaveTemplate(access, { by: 'grace', name: 'A', split: equal('ada', 'mallory') }, now).error!.type,
    ).toBe('SplitMemberNotInGroup');
    expect(decideSaveTemplate(access, { by: 'grace', name: 'A', split: equal('ada', 'ada') }, now).error!.type).toBe(
      'SplitMemberListedTwice',
    );
    expect(decideSaveTemplate(access, { by: 'grace', name: 'A', split: equal() }, now).error!.type).toBe(
      'TemplateWithoutMembers',
    );
    expect(decideSaveTemplate(access, { by: 'grace', name: 'A', split: byShares(['ada', 0]) }, now).error!.type).toBe(
      'InvalidSplitShares',
    );
  });
});

describe('replacing a template', () => {
  it('lets the member who saved it replace it, and the owner too', () => {
    const access = { template: stored(), memberIds: members, ownerId, nameTaken: false };
    expect(
      decideReplaceTemplate(access, { by: 'grace', name: 'Flat 2', split: byShares(['linus', 1]) }, now).isSuccess(),
    ).toBe(true);
    expect(decideReplaceTemplate(access, { by: ownerId, name: 'Flat', split: equal('ada') }, now).isSuccess()).toBe(
      true,
    );
  });

  it('refuses any other member before it looks at the values', () => {
    const decision = decideReplaceTemplate(
      { template: stored(), memberIds: members, ownerId, nameTaken: false },
      { by: 'linus', name: '', split: equal() },
      now,
    );
    expect(decision.error!.type).toBe('NotAllowed');
  });

  it('keeps the name of the template itself free to replace, and refuses another template’s name', () => {
    const decision = decideReplaceTemplate(
      { template: stored(), memberIds: members, ownerId, nameTaken: true },
      { by: 'grace', name: 'Flat', split: equal('ada') },
      now,
    );
    expect(decision.error!.type).toBe('TemplateNameTaken');
  });
});

describe('removing a template', () => {
  it('lets the member who saved it, or the owner, remove it, and refuses any other member', () => {
    expect(decideRemoveTemplate({ template: stored(), ownerId }, { by: 'grace' }, now).isSuccess()).toBe(true);
    expect(decideRemoveTemplate({ template: stored(), ownerId }, { by: ownerId }, now).isSuccess()).toBe(true);
    expect(decideRemoveTemplate({ template: stored(), ownerId }, { by: 'linus' }, now).error!.type).toBe('NotAllowed');
  });
});
