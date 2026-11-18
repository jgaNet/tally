/**
 * The shared kernel, in the DDD sense: the small part of the domain model every context
 * agrees on. Four things today, an Email, a Currency (its code and its minor unit), the Roles and the refusal of an archived group; the published contracts between
 * contexts are next door in Application/IntegrationEvents.
 */
export * from './Email';
export * from './Currency';
export * from './Role';
export * from './GroupArchived';
export * from './AccountSuspended';
export * from './AccountDeleted';
