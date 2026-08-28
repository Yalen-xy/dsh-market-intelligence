export class FakeClock {
  private currentTime: number;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(start: Date) {
    this.currentTime = start.getTime();
  }

  now = (): Date => new Date(this.currentTime);

  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextTimerId++;
    this.timers.set(id, { at: this.currentTime + delayMs, callback });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  async advance(delayMs: number): Promise<void> {
    const target = this.currentTime + delayMs;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, left], [, right]) => left.at - right.at || left - right)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.currentTime = timer.at;
      timer.callback();
      await flush();
    }
    this.currentTime = target;
    await flush();
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}

export function atShanghai(local: string): Date {
  const value = local.replace(' ', 'T');
  return new Date(`${value}${/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? ':00' : ''}+08:00`);
}

export async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
