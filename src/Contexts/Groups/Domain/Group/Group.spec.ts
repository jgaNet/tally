import { Currency } from './Currency';
import { Group } from './Group';
import { GroupCreatedEvent } from './GroupEvents';
import { GroupName } from './GroupName';

const at = new Date('2026-04-01T09:00:00.000Z');
const ownerId = '3c9d2f1e-0000-4000-8000-000000000001';

describe('Group.register', () => {
  it('makes the group, owned by its creator, and records its creation', () => {
    const group = Group.register({
      name: GroupName.create('Lisbon trip').data!,
      currency: Currency.create('EUR').data!,
      ownerId,
      at,
    });

    expect(group._id.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(group.ownerId).toBe(ownerId);
    expect(group.pullDomainEvents()).toEqual([
      GroupCreatedEvent.set({ groupId: group._id.value, ownerId, createdAt: at }),
    ]);
  });
});
