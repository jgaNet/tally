import { Module } from '@Architecture/Application';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { EventEmitter } from 'events';

import { GetOperationQueryHandler, GetOperationsQueryHandler } from '@Contexts/Tracker/Application/Queries';
import { SqliteOperationRecords } from '@Contexts/Tracker/Infrastructure/SqliteOperationRecords';
import { TrackedEventBus } from '@Contexts/Tracker/Infrastructure/TrackedEventBus';

const operationRecords = new SqliteOperationRecords(sharedDatabase());

// The application's event bus: the in-memory bus, decorated so that every operation is recorded.
export const trackedEventBus = new TrackedEventBus(
  new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: systemClock }),
  operationRecords,
);

export const localTrackerModule = new Module({
  name: 'Tracker',
  queries: [new GetOperationsQueryHandler(operationRecords), new GetOperationQueryHandler(operationRecords)],
});
