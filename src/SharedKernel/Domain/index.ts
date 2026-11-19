/**
 * The shared kernel, in the DDD sense: the small part of the domain model every context
 * agrees on. An Email, the Roles, the currencies with their minor units (ADR 30), and the refusal every change in an archived
 * group answers with (ADR 20); the published contracts between contexts are next door in Application/IntegrationEvents.
 */
export * from './Email';
export * from './Currency';
export * from './Role';
export * from './GroupArchived';
export * from './AccountSuspended';
export * from './AccountDeleted';
