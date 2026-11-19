/**
 * The shared kernel, in the DDD sense: the small part of the domain model every context
 * agrees on. An Email, the Roles, and the refusal every change in an archived group answers with (ADR 20); the published
 * contracts between contexts are next door in Application/IntegrationEvents.
 */
export * from './Email';
export * from './Role';
export * from './GroupArchived';
export * from './AccountSuspended';
export * from './AccountDeleted';
