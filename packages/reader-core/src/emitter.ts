export type EventListener<Payload> = (payload: Payload) => void;

/**
 * Minimal typed event emitter. `on` returns an unsubscribe function so engines
 * can hand removal straight back to their consumers.
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
      if (listeners.size === 0) {
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
