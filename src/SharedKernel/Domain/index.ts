/**
 * The shared kernel, in the DDD sense: the small part of the domain model every context
 * agrees on. An Email, the Roles and the Currencies today; the published contracts between
 * contexts are next door in Application/IntegrationEvents.
 */
export * from './AccountDeleted';
export * from './AccountSuspended';
export * from './Currency';
export * from './Email';
export * from './GroupArchived';
export * from './Rate';
export * from './Role';
