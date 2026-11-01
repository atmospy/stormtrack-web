class Toasts {
  items = $state<{ id: number; text: string; tone: 'info' | 'warn' }[]>([]);
  private n = 0;
  show(text: string, tone: 'info' | 'warn' = 'info', ms = 4000): void {
    const id = ++this.n;
    this.items = [...this.items.slice(-2), { id, text, tone }];
    setTimeout(() => (this.items = this.items.filter((t) => t.id !== id)), ms);
  }
}
export const toast = new Toasts();
