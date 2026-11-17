import { expect, jest } from '@jest/globals';

import { NotAllowedException, NotFoundException } from '@Architecture/Domain';
import { EventBus, ExecutionContext } from '@Architecture/Application';
import { Role } from '@SharedKernel/Domain';

import { GetMyAccountQueryHandler } from '@Contexts/Groups/Application/Queries/GetMyAccount/GetMyAccountQueryHandler';
import { InMemoryAccountReadModels } from '@Contexts/Groups/Infrastructure/InMemoryAccounts';

const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as EventBus;
const as = (role: Role, subjectId = '') =>
  new ExecutionContext({ traceId: 'trace', eventBus, auth: { subjectId, role } });

const store = new Map([
  ['alice', { id: 'alice', email: 'alice@example.com', name: 'Alice', passwordHash: 'secret', version: 1 }],
  ['bob', { id: 'bob', email: 'bob@example.com', name: 'Bob', passwordHash: 'secret', version: 1 }],
]);
const handler = new GetMyAccountQueryHandler(new InMemoryAccountReadModels(store));

describe('GetMyAccount', () => {
  it('shows a signed-in person their own account, and not the password', async () => {
    const result = await handler.execute(undefined, as(Role.USER, 'alice'));

    expect(result.data).toEqual({ id: 'alice', email: 'alice@example.com', name: 'Alice' });
  });

  it('asks an anonymous caller to sign in', async () => {
    expect((await handler.execute(undefined, as(Role.GUEST))).error).toBeInstanceOf(NotAllowedException);
  });

  it('does not find an account that does not exist', async () => {
    expect((await handler.execute(undefined, as(Role.USER, 'nobody'))).error).toBeInstanceOf(NotFoundException);
  });
});
