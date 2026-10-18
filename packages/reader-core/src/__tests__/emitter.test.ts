import { describe, expect, it, vi } from 'vitest';
import { TypedEmitter } from '../emitter';

interface Events {
  ping: { value: number };
}

describe('TypedEmitter', () => {
  it('notifies every listener', () => {
    const emitter = new TypedEmitter<Events>();
    const first = vi.fn();
    const second = vi.fn();

    emitter.on('ping', first);
    emitter.on('ping', second);
    emitter.emit('ping', { value: 1 });

    expect(first).toHaveBeenCalledWith({ value: 1 });
    expect(second).toHaveBeenCalledWith({ value: 1 });
  });

  it('finishes the current emit when a listener unsubscribes another', () => {
    const emitter = new TypedEmitter<Events>();
    let offSecond: () => void = () => {};
    const first = vi.fn(() => offSecond());
    const second = vi.fn();

    emitter.on('ping', first);
    offSecond = emitter.on('ping', second);

    emitter.emit('ping', { value: 1 });
    expect(second).toHaveBeenCalledTimes(1);

    emitter.emit('ping', { value: 2 });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('tolerates calling an unsubscribe twice', () => {
    const emitter = new TypedEmitter<Events>();
    const listener = vi.fn();

    const off = emitter.on('ping', listener);
    off();
    expect(() => off()).not.toThrow();

    emitter.emit('ping', { value: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not let a stale unsubscribe delete a listener registered after clear', () => {
    const emitter = new TypedEmitter<Events>();
    const stale = vi.fn();
    const fresh = vi.fn();

    const off = emitter.on('ping', stale);
    emitter.clear();
    emitter.on('ping', fresh);

    off();
    emitter.emit('ping', { value: 1 });

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('dedupes the same listener registered twice', () => {
    const emitter = new TypedEmitter<Events>();
    const listener = vi.fn();

    emitter.on('ping', listener);
    emitter.on('ping', listener);
    emitter.emit('ping', { value: 1 });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
