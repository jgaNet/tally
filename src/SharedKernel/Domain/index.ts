/**
 * The shared kernel, in the DDD sense: the small part of the domain model every context
 * agrees on. Five things today, an Email, the Roles, the Currencies and the GroupArchived and AccountSuspended refusals; the published contracts
 * between contexts are next door in Application/IntegrationEvents.
 */
export * from './Email';
export * from './Role';
export * from './Currency';
export * from './GroupArchived';
export * from './AccountSuspended';
