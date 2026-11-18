import { ConcurrencyConflictException, Id } from '@Architecture/Domain';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';
import { freshDatabase } from '@Architecture/Infrastructure/Postgres/database.spec-helper';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { PostgresGroupRepository } from '@Contexts/Groups/Infrastructure/PostgresGroupRepository';

describe('PostgresGroupRepository', () => {
  it('loads what it saved, and refuses a save of a group changed since it was read', async () => {
    const database = freshDatabase();
    const repository = new PostgresGroupRepository(database);
    const unit = new PostgresUnitOfWork(database);
    await unit.beginTransaction();
    const group = Group.create({
      name: GroupName.create('Club').data as GroupName,
      currency: Currency.create('EUR').data as Currency,
      ownerId: new Id('owner'),
      at: new Date('2026-05-01T10:00:00.000Z'),
    });
    expect((await repository.save(group)).isFailure()).toBe(false);

    const read = (await repository.findById(group._id)) as Group;
    expect(read.toSnapshot()).toEqual({ ...group.toSnapshot(), version: 1 });
    expect(await repository.findById(new Id('nobody'))).toBeNull();

    // Two readers of version 1: the first to save wins, the second is refused.
    const first = await repository.findById(group._id);
    const second = await repository.findById(group._id);
    expect((await repository.save(first as Group)).isFailure()).toBe(false);
    const refused = await repository.save(second as Group);
    expect(refused.isFailure() && refused.error).toBeInstanceOf(ConcurrencyConflictException);
    await unit.rollbackTransaction();
    await database.close();
  });
});
