import type { ControlPosition, IControl, Map as MlMap } from 'maplibre-gl';

type Mode = 'globe' | 'mercator';
const KEY = 'st.projection';

const ICON: Record<Mode, string> = {
  // what pressing the button switches TO: from globe -> flat map, from flat -> globe
  globe: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M9 6v12M15 6v12M3 12h18"/></svg>',
  mercator: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>'
};

export function savedProjection(): Mode {
  try {
    return localStorage.getItem(KEY) === 'mercator' ? 'mercator' : 'globe';
  } catch {
    return 'globe';
  }
}

/** One-button Globe / Flat switch in MapLibre's own control-group styling. */
export class ProjectionControl implements IControl {
  private box: HTMLDivElement | null = null;
  private btn: HTMLButtonElement | null = null;
  private mode: Mode = savedProjection();
  private map: MlMap | null = null;

  onAdd(map: MlMap): HTMLElement {
    this.map = map;
    this.box = document.createElement('div');
    this.box.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.addEventListener('click', () => this.set(this.mode === 'globe' ? 'mercator' : 'globe'));
    this.box.append(this.btn);
    this.paint();
    if (this.mode !== 'globe') map.setProjection({ type: this.mode });
    return this.box;
  }

  onRemove(): void {
    this.box?.remove();
    this.box = this.btn = this.map = null;
  }

  getDefaultPosition(): ControlPosition {
    return 'top-right';
  }

  private set(mode: Mode): void {
    this.mode = mode;
    this.map?.setProjection({ type: mode });
    try {
      localStorage.setItem(KEY, mode);
    } catch { /* private mode: the choice just isn't remembered */ }
    this.paint();
  }

  private paint(): void {
    if (!this.btn) return;
    const label = this.mode === 'globe' ? 'Switch to flat map' : 'Switch to globe';
    this.btn.title = label;
    this.btn.setAttribute('aria-label', label);
    this.btn.innerHTML = ICON[this.mode];
    this.btn.style.color = 'var(--text, #dfe8ff)';
  }
}
