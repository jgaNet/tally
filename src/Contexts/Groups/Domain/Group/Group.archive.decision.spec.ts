import { Currency } from './Currency';
import { Group } from './Group';
import { decideArchiveGroup, decideLeaveGroup } from './Group.decision';
import { GroupName } from './GroupName';

const NOW = new Date('2026-06-01T10:00:00Z');

/** A group owned by `owner`, which `member` has joined. */
function groupOf(owner: string, member: string): Group {
  const group = Group.register({
    name: GroupName.create('Flat').data!,
    currency: Currency.create('EUR').data!,
    ownerId: owner,
    at: new Date('2020-01-01T10:00:00Z'),
  });
  group.join(member, new Date('2020-01-02T10:00:00Z'));
  return group;
}

const settled = { archived: false, ownerId: 'owner', balances: [0, 0], waiting: false };

describe('decideArchiveGroup (request 27)', () => {
  it('lets the owner archive a group whose every balance is 0 and where no payment waits', () => {
    expect(decideArchiveGroup(settled, { by: 'owner' }, NOW).isSuccess()).toBe(true);
  });

  it('refuses anyone but the owner, by NotAllowed', () => {
    expect(decideArchiveGroup(settled, { by: 'member' }, NOW).error).toMatchObject({ type: 'NotAllowed' });
  });

  it('refuses a group whose balances are not all 0, and one with a payment waiting', () => {
    expect(decideArchiveGroup({ ...settled, balances: [50, -50] }, { by: 'owner' }, NOW).error).toMatchObject({
      type: 'BalancesNotSettled',
    });
    expect(decideArchiveGroup({ ...settled, waiting: true }, { by: 'owner' }, NOW).error).toMatchObject({
      type: 'PaymentsWaiting',
    });
  });

  it('refuses an archive made already, by the one rule, before anything else', () => {
    expect(
      decideArchiveGroup({ ...settled, archived: true, balances: [5] }, { by: 'member' }, NOW).error,
    ).toMatchObject({
      type: 'GroupArchived',
    });
  });
});

describe('Group.archive (request 27)', () => {
  it('records the archive, shows it once, and refuses a second one by GroupArchived', () => {
    const group = groupOf('owner', 'member');
    expect(group.archivedAt).toBeUndefined();

    expect(group.archive(NOW).isSuccess()).toBe(true);
    expect(group.archivedAt).toEqual(NOW);
    expect(group.toSnapshot().archivedAt).toBe(NOW.toISOString());
    expect(group.archive(NOW).error).toMatchObject({ type: 'GroupArchived' });
  });

  it('refuses a member leaving, and a member joining, once it is archived', () => {
    const group = groupOf('owner', 'member');
    group.archive(NOW);
    expect(group.leave('member', NOW, 0).error).toMatchObject({ type: 'GroupArchived' });
    expect(group.join('linus', NOW).error).toMatchObject({ type: 'GroupArchived' });
  });

  it('refuses the owner leaving an archived group by the same name, not by the owner rule', () => {
    expect(
      decideLeaveGroup({ ownerId: 'owner', balance: 0, waiting: false, archived: true }, { by: 'owner' }, NOW).error,
    ).toMatchObject({ type: 'GroupArchived' });
  });
});
