/**
 * The shared kernel, in the DDD sense: the small part of the domain model every context
 * agrees on. Three things today, an Email, the Roles and the one rule an archived group refuses
 * a change by (GroupArchived, feature 27); the published contracts between contexts are next
 * door in Application/IntegrationEvents.
 */
export * from './Email';
export * from './GroupArchived';
export * from './Role';
