import type { SyncChangeEnvelope } from '@bookr/shared';

/**
 * Fan-out of freshly committed changes to open streams. It is deliberately
 * in-process: a stream only needs changes committed by this server instance,
 * and SSE clients recover anything else through the change log by cursor.
 */
export interface SyncHub {
  /** Delivers a committed change to every stream the user has open. */
  publish(userId: string, change: SyncChangeEnvelope): void;
  /** Registers one listener and returns the function that removes it. */
  subscribe(userId: string, listener: (change: SyncChangeEnvelope) => void): () => void;
  /** Number of open listeners for a user, used by tests and diagnostics. */
  subscriberCount(userId: string): number;
}

/** Creates an empty hub. Each app process owns exactly one. */
export function createSyncHub(): SyncHub {
  const listeners = new Map<string, Set<(change: SyncChangeEnvelope) => void>>();

  return {
    publish(userId, change) {
      const userListeners = listeners.get(userId);
      if (!userListeners) {
        return;
      }
      // Copy first: a listener may unsubscribe while it is being notified.
      for (const listener of [...userListeners]) {
        try {
          listener(change);
        } catch {
          // A broken stream must not keep the change from the others; the
          // stream route removes its own listener when writing fails.
        }
      }
    },

    subscribe(userId, listener) {
      let userListeners = listeners.get(userId);
      if (!userListeners) {
        userListeners = new Set();
        listeners.set(userId, userListeners);
      }
      userListeners.add(listener);

      let subscribed = true;
      return () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        const current = listeners.get(userId);
        if (!current) {
          return;
        }
        current.delete(listener);
        if (current.size === 0) {
          listeners.delete(userId);
        }
      };
    },

    subscriberCount(userId) {
      return listeners.get(userId)?.size ?? 0;
    },
  };
}
