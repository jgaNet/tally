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

describe('decideLeaveGroup (request 20)', () => {
  it('lets a member leave whatever their balance, and answers the balance that passes to the owner', () => {
    for (const balance of [0, 300, -300]) {
      const decision = decideLeaveGroup({ ownerId: 'owner', balance, waiting: false }, { by: 'member' }, new Date());
      expect(decision.isFailure()).toBe(false);
      expect(decision.data?.state.balancePassed).toBe(balance);
    }
  });

  it('refuses the owner, whatever their balance', () => {
    const decision = decideLeaveGroup({ ownerId: 'owner', balance: 0, waiting: false }, { by: 'owner' }, new Date());
    expect(decision.error?.type).toBe('OwnerCannotLeave');
  });

  it('refuses a member while a payment of theirs through the provider waits', () => {
    const decision = decideLeaveGroup({ ownerId: 'owner', balance: 0, waiting: true }, { by: 'member' }, new Date());
    expect(decision.error?.type).toBe('PaymentWaiting');
  });
});

describe('Group.leave (request 20)', () => {
  it('takes the member out, records MemberLeft and BalancePassed to the owner, the owner staying first', () => {
    const group = groupOf('owner', 'member');

    const left = group.leave('member', new Date('2020-02-01T10:00:00Z'), -300);

    expect(left.isFailure()).toBe(false);
    expect(group.hasMember('member')).toBe(false);
    expect(group.members.map(member => member.accountId)).toEqual(['owner']);
    const events = group.pullDomainEvents();
    expect(events.map(event => event.constructor.name)).toEqual(
      expect.arrayContaining(['MemberLeftEvent', 'BalancePassedEvent']),
    );
    expect(group.newPasses).toEqual([
      { from: 'member', to: 'owner', amount: -300, at: new Date('2020-02-01T10:00:00Z') },
    ]);
  });

  it('refuses the owner, and an account that is not a member', () => {
    const group = groupOf('owner', 'member');
    expect(group.leave('owner', new Date(), 0).error?.type).toBe('OwnerCannotLeave');
    expect(group.leave('stranger', new Date(), 0).error?.type).toBe('NotFound');
  });

  it('lets a member who left join again, last', () => {
    const group = groupOf('owner', 'member');
    group.join('other', new Date('2020-01-03T10:00:00Z'));
    group.leave('member', new Date('2020-02-01T10:00:00Z'), 0);

    group.join('member', new Date('2020-03-01T10:00:00Z'));

    expect(group.members.map(member => member.accountId)).toEqual(['owner', 'other', 'member']);
  });
});
