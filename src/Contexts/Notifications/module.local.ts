import { LiteModule } from '@Architecture/Application/Lite/LiteModule';

/**
 * The Notifications context, declared by checkpoint 2's strategic session before request 11 (conventions/domain.yaml, ADR 11).
 * It has no use case or reaction yet: the features that need it bring them.
 */
export const localNotificationsModule = new LiteModule({ name: 'Notifications' });
