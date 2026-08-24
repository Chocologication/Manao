import { describe, expect, it, vi } from 'vitest';
import { WorkspaceResourceRegistry } from './WorkspaceResourceRegistry';

describe('WorkspaceResourceRegistry', () => {
  it('register returns an unregister function', () => {
    const registry = new WorkspaceResourceRegistry();
    const dispose = vi.fn();
    const unregister = registry.register(dispose);

    unregister();
    registry.disposeAll();

    expect(dispose).not.toHaveBeenCalled();
  });

  it('disposeAll invokes each disposer once and clears the set', () => {
    const registry = new WorkspaceResourceRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.register(first);
    registry.register(second);

    registry.disposeAll();
    registry.disposeAll();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('disposeAll still disposes remaining resources when one disposer throws', () => {
    const registry = new WorkspaceResourceRegistry();
    const throwing = vi.fn(() => {
      throw new Error('dispose failed');
    });
    const remaining = vi.fn();
    registry.register(throwing);
    registry.register(remaining);

    expect(() => registry.disposeAll()).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(remaining).toHaveBeenCalledTimes(1);

    registry.disposeAll();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(remaining).toHaveBeenCalledTimes(1);
  });

  it('registerLazy keeps the disposer across disposeAll', () => {
    const registry = new WorkspaceResourceRegistry();
    const dispose = vi.fn();
    const unregister = registry.registerLazy(dispose);

    registry.disposeAll();
    registry.disposeAll();
    expect(dispose).toHaveBeenCalledTimes(2);

    unregister();
    registry.disposeAll();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('registerLazy still runs remaining disposers when one throws', () => {
    const registry = new WorkspaceResourceRegistry();
    const throwing = vi.fn(() => {
      throw new Error('lazy dispose failed');
    });
    const remaining = vi.fn();
    registry.registerLazy(throwing);
    registry.register(remaining);

    expect(() => registry.disposeAll()).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(remaining).toHaveBeenCalledTimes(1);
  });

  it('defers a workspace generation registered during disposeAll until the next cleanup', () => {
    const registry = new WorkspaceResourceRegistry();
    const nextGeneration = vi.fn();
    registry.register(() => {
      registry.register(nextGeneration);
    });

    registry.disposeAll();
    expect(nextGeneration).not.toHaveBeenCalled();

    registry.disposeAll();
    expect(nextGeneration).toHaveBeenCalledOnce();
  });
});
