/**
 * The shared kernel, in the DDD sense: the small part of the domain model every context
 * agrees on. Three things today, an Email, the Roles and the refusal of an archived group; the published contracts between
 * contexts are next door in Application/IntegrationEvents.
 */
export * from './Email';
export * from './Role';
export * from './GroupArchived';
export * from './AccountSuspended';
