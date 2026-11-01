import { GATE } from '#lib/config';

export interface GateConfig {
  activeMs: number;
  interactions: number;
  snoozeMs: number;
  storageKey: string;
}
export interface GateStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
export interface GateDeps {
  now: () => number;
  storage: GateStorage | null;
}

/**
 * Login-gate trigger logic (CONTRACTS section 5), free of DOM/timers so it is unit-testable.
 * Fires when active (tab-visible) time reaches `activeMs` OR `interactions` meaningful
 * interactions have happened, unless snoozed. Once fired it stays fired until dismissed.
 */
export class LoginGate {
  private activeMs = 0;
  private interactions = 0;
  private visible = true;
  private last: number;
  private fired = false;
  private suppressed = false;

  constructor(
    private readonly cfg: GateConfig = GATE,
    private readonly deps: GateDeps = { now: () => Date.now(), storage: safeStorage() }
  ) {
    this.last = deps.now();
  }

  /** Accumulate elapsed active time. Call periodically and on visibility changes. */
  tick(): void {
    const t = this.deps.now();
    if (this.visible) this.activeMs += Math.max(0, t - this.last);
    this.last = t;
    this.evaluate();
  }

  setVisible(visible: boolean): void {
    this.tick();
    this.visible = visible;
  }

  /** Count one meaningful interaction (layer toggle, storm click, search, scrub). */
  interact(): void {
    this.interactions++;
    this.tick();
  }

  /** Signed-in users never see the card. */
  setSuppressed(v: boolean): void {
    this.suppressed = v;
    if (v) this.fired = false;
    else this.evaluate();
  }

  snoozed(): boolean {
    try {
      const until = Number(this.deps.storage?.getItem(this.cfg.storageKey) ?? 0);
      return until > this.deps.now();
    } catch {
      return false;
    }
  }

  /** "Not now": hide and snooze for `snoozeMs`. */
  dismiss(): void {
    this.fired = false;
    try {
      this.deps.storage?.setItem(this.cfg.storageKey, String(this.deps.now() + this.cfg.snoozeMs));
    } catch {
      /* storage unavailable: still hide for this session via the counters below */
    }
    this.activeMs = -Infinity; // do not re-trigger in this page load either
    this.interactions = -Infinity;
  }

  private evaluate(): void {
    if (this.fired || this.suppressed) return;
    if (this.activeMs >= this.cfg.activeMs || this.interactions >= this.cfg.interactions) {
      if (!this.snoozed()) this.fired = true;
    }
  }

  get shouldShow(): boolean {
    return this.fired && !this.suppressed;
  }
  get stats(): { activeMs: number; interactions: number } {
    return { activeMs: this.activeMs, interactions: this.interactions };
  }
}

function safeStorage(): GateStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
