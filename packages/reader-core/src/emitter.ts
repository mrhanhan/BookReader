export type EventListener<Payload> = (payload: Payload) => void;

/**
 * Minimal typed event emitter. `on` returns an unsubscribe function so engines
 * can hand removal straight back to their consumers.
 *
 * Listeners run synchronously in registration order. A listener that throws
 * propagates the exception and aborts the remaining listeners for that emit;
 * the emitter deliberately adds no internal error handling.
 */
export class TypedEmitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<EventListener<never>>>();

  on<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set<EventListener<never>>();
      this.listeners.set(event, listeners);
    }

    const stored = listener as EventListener<never>;
    listeners.add(stored);

    return () => {
      listeners.delete(stored);
      // clear() or a later on() may have replaced the set; only remove the map
      // entry while it is still the exact set this unsubscribe belongs to.
      if (listeners.size === 0 && this.listeners.get(event) === listeners) {
        this.listeners.delete(event);
      }
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const listeners = this.listeners.get(event);
    if (!listeners) {
      return;
    }

    // Copy first so a listener that unsubscribes cannot disturb this dispatch.
    for (const listener of [...listeners]) {
      (listener as EventListener<Events[K]>)(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
