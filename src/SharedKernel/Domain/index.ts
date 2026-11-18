/**
 * The shared kernel, in the DDD sense: the small part of the domain model every context
 * agrees on. Four things today, an Email, the Roles, the one rule an archived group refuses
 * a change by (GroupArchived, feature 27) and the one rule a suspended account is refused by
 * (AccountSuspended, feature 34); the published contracts between contexts are next
 * door in Application/IntegrationEvents.
 */
export * from './AccountSuspended';
export * from './Email';
export * from './GroupArchived';
export * from './Role';
