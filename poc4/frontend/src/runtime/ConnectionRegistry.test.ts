import { describe, expect, it, vi } from 'vitest';
import { ConnectionRegistry } from './ConnectionRegistry';

describe('ConnectionRegistry', () => {
  it('register returns an unregister function', () => {
    const registry = new ConnectionRegistry();
    const close = vi.fn();
    const unregister = registry.register(close);

    unregister();
    registry.closeAll();

    expect(close).not.toHaveBeenCalled();
  });

  it('closeAll invokes each closer once and clears the set', () => {
    const registry = new ConnectionRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.register(first);
    registry.register(second);

    registry.closeAll();
    registry.closeAll();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('closeAll still closes remaining connections when one closer throws', () => {
    const registry = new ConnectionRegistry();
    const throwing = vi.fn(() => {
      throw new Error('close failed');
    });
    const remaining = vi.fn();
    registry.register(throwing);
    registry.register(remaining);

    expect(() => registry.closeAll()).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(remaining).toHaveBeenCalledTimes(1);

    registry.closeAll();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(remaining).toHaveBeenCalledTimes(1);
  });

  it('unregister is idempotent so a transport dispose can always unregister', () => {
    const registry = new ConnectionRegistry();
    const close = vi.fn();
    const unregister = registry.register(close);
    unregister();
    unregister();
    registry.closeAll();
    expect(close).not.toHaveBeenCalled();
  });

  it('closeAll still runs remaining closers when one closer unregisters itself', () => {
    const registry = new ConnectionRegistry();
    const remaining = vi.fn();
    let unregisterSelf: () => void = () => {};
    const self = vi.fn(() => {
      unregisterSelf();
    });
    unregisterSelf = registry.register(self);
    registry.register(remaining);

    expect(() => registry.closeAll()).not.toThrow();
    expect(self).toHaveBeenCalledTimes(1);
    expect(remaining).toHaveBeenCalledTimes(1);
  });

  it('defers a connection generation registered during closeAll until the next cleanup', () => {
    const registry = new ConnectionRegistry();
    const nextGeneration = vi.fn();
    registry.register(() => {
      registry.register(nextGeneration);
    });

    registry.closeAll();
    expect(nextGeneration).not.toHaveBeenCalled();

    registry.closeAll();
    expect(nextGeneration).toHaveBeenCalledOnce();
  });
});
