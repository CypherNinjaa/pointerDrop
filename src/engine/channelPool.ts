import { HIGH_WATERMARK, LOW_WATERMARK } from './protocol';

/**
 * Striped sender across N unordered RTCDataChannels with a hardware-style
 * watermark valve. Usable from the main thread (bridge mode) or from inside the
 * transfer worker when the browser supports transferable RTCDataChannels.
 *
 *  • Each frame goes to the open channel with the smallest bufferedAmount among
 *    the first `activeCount` channels (degraded links scale 4 → 2).
 *  • When the aggregate bufferedAmount crosses HIGH_WATERMARK (4 MB) the valve
 *    closes; `onbufferedamountlow` (threshold LOW_WATERMARK, 512 KB) re-opens it
 *    once the aggregate has drained back below LOW_WATERMARK.
 */
export class ChannelPool {
  readonly channels: RTCDataChannel[];
  activeCount: number;
  private closed = false;
  private drainWaiters: Array<() => void> = [];
  private valveListeners = new Set<(open: boolean) => void>();
  private valveOpen = true;

  constructor(channels: RTCDataChannel[]) {
    this.channels = channels;
    this.activeCount = channels.length;
    for (const channel of channels) {
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = LOW_WATERMARK;
      channel.addEventListener('bufferedamountlow', this.handleLow);
      channel.addEventListener('close', this.handleClose);
    }
  }

  get totalBuffered(): number {
    let sum = 0;
    for (const channel of this.channels) sum += channel.bufferedAmount;
    return sum;
  }

  get bufferedAmounts(): number[] {
    return this.channels.map((c) => c.bufferedAmount);
  }

  get isOpen(): boolean {
    return !this.closed && this.channels.slice(0, this.activeCount).some((c) => c.readyState === 'open');
  }

  get canSend(): boolean {
    return this.totalBuffered < HIGH_WATERMARK;
  }

  setActiveCount(count: number): void {
    this.activeCount = Math.max(1, Math.min(this.channels.length, count));
  }

  /** Sends one frame on the least-loaded channel. Returns false if no channel is open. */
  send(frame: ArrayBuffer): boolean {
    let best: RTCDataChannel | null = null;
    for (let i = 0; i < this.activeCount; i++) {
      const channel = this.channels[i];
      if (channel.readyState !== 'open') continue;
      if (!best || channel.bufferedAmount < best.bufferedAmount) best = channel;
    }
    if (!best) return false;
    best.send(frame);
    if (this.valveOpen && this.totalBuffered >= HIGH_WATERMARK) {
      this.setValve(false);
      this.scheduleRecheck();
    }
    return true;
  }

  /** Aggregate level at which the valve re-opens: the per-channel 512 KB low watermark × active channels. */
  get resumeLevel(): number {
    return LOW_WATERMARK * this.activeCount;
  }

  /** Resolves when the aggregate buffer drains below the resume level (or the pool closes). */
  waitForDrain(): Promise<void> {
    if (this.closed || this.totalBuffered <= this.resumeLevel) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
      this.scheduleRecheck();
    });
  }

  /** Resolves once every queued byte has left the SCTP buffers. */
  async flush(): Promise<void> {
    while (!this.closed && this.totalBuffered > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  onValve(listener: (open: boolean) => void): () => void {
    this.valveListeners.add(listener);
    return () => this.valveListeners.delete(listener);
  }

  dispose(): void {
    this.closed = true;
    for (const channel of this.channels) {
      channel.removeEventListener('bufferedamountlow', this.handleLow);
      channel.removeEventListener('close', this.handleClose);
    }
    this.releaseWaiters();
  }

  private setValve(open: boolean): void {
    this.valveOpen = open;
    for (const listener of this.valveListeners) listener(open);
  }

  private releaseWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private handleLow = (): void => {
    if (this.totalBuffered > this.resumeLevel) {
      // A sibling channel is still above its watermark and may never cross it again
      // if it is already idle — re-check shortly instead of waiting for another event.
      this.scheduleRecheck();
      return;
    }
    if (!this.valveOpen) this.setValve(true);
    this.releaseWaiters();
  };

  private recheckTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleRecheck(): void {
    if (this.recheckTimer !== null || this.closed) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      if (this.valveOpen && this.drainWaiters.length === 0) return;
      this.handleLow();
    }, 8);
  }

  private handleClose = (): void => {
    if (this.channels.every((c) => c.readyState === 'closed' || c.readyState === 'closing')) {
      this.closed = true;
      this.releaseWaiters();
    }
  };
}
