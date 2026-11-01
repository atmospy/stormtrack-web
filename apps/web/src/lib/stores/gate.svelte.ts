import { LoginGate } from '#lib/auth/gate';

/** Reactive wrapper around the pure LoginGate. */
class GateStore {
  private gate = new LoginGate();
  show = $state(false);
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): () => void {
    const sync = () => {
      this.gate.tick();
      this.show = this.gate.shouldShow;
    };
    const onVis = () => {
      this.gate.setVisible(document.visibilityState === 'visible');
      sync();
    };
    this.gate.setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    this.timer = setInterval(sync, 1000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (this.timer) clearInterval(this.timer);
    };
  }

  interact(): void {
    this.gate.interact();
    this.show = this.gate.shouldShow;
  }
  setSignedIn(v: boolean): void {
    this.gate.setSuppressed(v);
    this.show = this.gate.shouldShow;
  }
  dismiss(): void {
    this.gate.dismiss();
    this.show = false;
  }
}
export const gate = new GateStore();
