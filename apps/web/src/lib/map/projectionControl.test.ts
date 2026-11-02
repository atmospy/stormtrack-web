import { describe, expect, it, vi } from 'vitest';
import { ProjectionControl } from './projectionControl';

function fakeMap(loaded: boolean) {
  const calls: string[] = [];
  let styleLoad: (() => void) | null = null;
  return {
    calls,
    fireStyleLoad: () => styleLoad?.(),
    isStyleLoaded: () => loaded,
    setProjection: (p: { type: string }) => {
      if (!loaded) throw new Error('Style is not done loading.');
      calls.push(p.type);
    },
    once: (_e: string, fn: () => void) => {
      styleLoad = () => {
        loaded = true;
        fn();
      };
    }
  };
}

describe('ProjectionControl startup', () => {
  it('does not throw and applies a saved flat map once the style has loaded', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'mercator', setItem: () => {} });
    vi.stubGlobal('document', { createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {}, remove() {} }) });
    const m = fakeMap(false);
    expect(() => new ProjectionControl().onAdd(m as never)).not.toThrow();
    expect(m.calls).toEqual([]);
    m.fireStyleLoad();
    expect(m.calls).toEqual(['mercator']);
  });
  it('applies immediately when the style is already loaded', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'mercator', setItem: () => {} });
    vi.stubGlobal('document', { createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {}, remove() {} }) });
    const m = fakeMap(true);
    new ProjectionControl().onAdd(m as never);
    expect(m.calls).toEqual(['mercator']);
  });
});
