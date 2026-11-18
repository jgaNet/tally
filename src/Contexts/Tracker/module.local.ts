import { Module } from '@Architecture/Application';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { applicationDatabase } from '@Architecture/Infrastructure/Postgres/ApplicationDatabase';
import { EventEmitter } from 'events';

import { GetOperationQueryHandler, GetOperationsQueryHandler } from '@Contexts/Tracker/Application/Queries';
import { PostgresOperationRecords } from '@Contexts/Tracker/Infrastructure/PostgresOperationRecords';
import { TrackedEventBus } from '@Contexts/Tracker/Infrastructure/TrackedEventBus';

const operationRecords = new PostgresOperationRecords(applicationDatabase());

// The application's event bus: the in-memory bus, decorated so that every operation is recorded.
export const trackedEventBus = new TrackedEventBus(
  new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: systemClock }),
  operationRecords,
);

export const localTrackerModule = new Module({
  name: 'Tracker',
  queries: [new GetOperationsQueryHandler(operationRecords), new GetOperationQueryHandler(operationRecords)],
});
