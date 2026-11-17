import { Currency } from './Currency';
import { Group } from './Group';
import { decideLeaveGroup } from './Group.decision';
import { GroupName } from './GroupName';

/** A group owned by `owner`, which `member` has joined, as the storm's join order has it. */
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

describe('decideLeaveGroup (request 9)', () => {
  it('lets a member leave once their balance is 0', () => {
    expect(decideLeaveGroup({ ownerId: 'owner', balance: 0 }, { by: 'member' }, new Date()).isFailure()).toBe(false);
  });

  it('refuses the owner, whatever their balance', () => {
    const decision = decideLeaveGroup({ ownerId: 'owner', balance: 0 }, { by: 'owner' }, new Date());
    expect(decision.error?.type).toBe('OwnerCannotLeave');
  });

  it('refuses a member whose balance is not 0, owed or owing', () => {
    expect(decideLeaveGroup({ ownerId: 'owner', balance: 300 }, { by: 'member' }, new Date()).error?.type).toBe(
      'BalanceNotZero',
    );
    expect(decideLeaveGroup({ ownerId: 'owner', balance: -1 }, { by: 'member' }, new Date()).error?.type).toBe(
      'BalanceNotZero',
    );
  });
});

describe('Group.leave (request 9)', () => {
  it('takes the member out and records MemberLeft, the owner staying first', () => {
    const group = groupOf('owner', 'member');

    const left = group.leave('member', new Date('2020-02-01T10:00:00Z'));

    expect(left.isFailure()).toBe(false);
    expect(group.hasMember('member')).toBe(false);
    expect(group.members.map(member => member.accountId)).toEqual(['owner']);
    const events = group.pullDomainEvents();
    expect(events.map(event => event.constructor.name)).toContain('MemberLeftEvent');
  });

  it('refuses the owner, and an account that is not a member', () => {
    const group = groupOf('owner', 'member');
    expect(group.leave('owner', new Date()).error?.type).toBe('OwnerCannotLeave');
    expect(group.leave('stranger', new Date()).error?.type).toBe('NotFound');
  });

  it('lets a member who left join again, last', () => {
    const group = groupOf('owner', 'member');
    group.join('other', new Date('2020-01-03T10:00:00Z'));
    group.leave('member', new Date('2020-02-01T10:00:00Z'));

    group.join('member', new Date('2020-03-01T10:00:00Z'));

    expect(group.members.map(member => member.accountId)).toEqual(['owner', 'other', 'member']);
  });
});
