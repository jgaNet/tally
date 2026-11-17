import { Module } from '@Architecture/Application';

/**
 * The Notifications context, declared by checkpoint 2's strategic session before request 11 (conventions/domain.yaml, ADR 5).
 * It has no command, query or reaction yet: the features that need it bring them.
 */
export const localNotificationsModule = new Module({ name: 'Notifications' });
