import { lowWatermarkFor } from './autotune';
import { CHANNEL_COUNT, INITIAL_HIGH_WATERMARK, type SchedulePolicy } from './protocol';

interface Lane {
  id: string;
  channels: RTCDataChannel[];
}

/**
 * Striped sender across N lanes × M unordered RTCDataChannels with an adaptive
 * watermark valve. Usable from the main thread (bridge mode) or from inside the
 * transfer worker when the browser supports transferable RTCDataChannels.
 *
 *  • A lane is one RTCPeerConnection (one SCTP association / congestion window).
 *    Lane "0" is the primary connection; extra lanes are added at runtime.
 *  • Supports both `least-buffered` (default) and `round-robin` channel selection,
 *    and configurable `channelsPerPrimaryLane` (1, 2, or 4) for repeatable A/B sweeps.
 *  • Accepts either an `ArrayBuffer` or a `Uint8Array` view over a reusable scratch
 *    buffer (`RTCDataChannel.send` copies synchronously into browser C++ memory),
 *    eliminating per-chunk JS heap allocations in native worker mode.
 */
export class ChannelPool {
  private lanes: Lane[] = [];
  activeLanes = Number.POSITIVE_INFINITY;
  channelsPerPrimaryLane = CHANNEL_COUNT;
  schedulePolicy: SchedulePolicy = 'least-buffered';
  highWatermark = INITIAL_HIGH_WATERMARK;
  sentBytes = 0;
  recheckPolls = 0;
  private rrCursor = 0;
  private closed = false;
  private drainWaiters: Array<() => void> = [];
  private valveListeners = new Set<(open: boolean) => void>();
  private valveOpen = true;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(primary?: RTCDataChannel[]) {
    if (primary) this.addLane('0', primary);
  }

  addLane(id: string, channels: RTCDataChannel[]): void {
    this.removeLane(id);
    for (const channel of channels) {
      channel.binaryType = 'arraybuffer';
      channel.addEventListener('bufferedamountlow', this.handleLow);
      channel.addEventListener('close', this.handleClose);
    }
    this.lanes.push({ id, channels });
    this.lanes.sort((a, b) =>
      a.id === '0' ? -1 : b.id === '0' ? 1 : a.id.localeCompare(b.id, undefined, { numeric: true }),
    );
    this.applyThresholds();
  }

  removeLane(id: string): RTCDataChannel[] | null {
    const idx = this.lanes.findIndex((l) => l.id === id);
    if (idx === -1) return null;
    const [lane] = this.lanes.splice(idx, 1);
    for (const channel of lane.channels) {
      channel.removeEventListener('bufferedamountlow', this.handleLow);
      channel.removeEventListener('close', this.handleClose);
    }
    this.applyThresholds();
    this.handleLow();
    return lane.channels;
  }

  get laneIds(): string[] {
    return this.lanes.map((l) => l.id);
  }

  get channels(): RTCDataChannel[] {
    return this.lanes.flatMap((l) => l.channels);
  }

  /** Lane id for each entry of `bufferedAmounts`. */
  get channelLaneIds(): string[] {
    return this.lanes.flatMap((l) => l.channels.map(() => l.id));
  }

  /** Lanes with at least one open channel. */
  get openLaneCount(): number {
    let n = 0;
    for (const lane of this.lanes) if (lane.channels.some((c) => c.readyState === 'open')) n++;
    return n;
  }

  get activeLaneCount(): number {
    return Math.min(this.activeLanes, this.openLaneCount);
  }

  get activeChannelCount(): number {
    let count = 0;
    let lanesSeen = 0;
    for (const lane of this.lanes) {
      if (lanesSeen >= this.activeLanes) break;
      const limit = lane.id === '0' ? Math.min(lane.channels.length, this.channelsPerPrimaryLane) : lane.channels.length;
      let anyOpen = false;
      for (let i = 0; i < limit; i++) {
        if (lane.channels[i].readyState === 'open') {
          anyOpen = true;
          count++;
        }
      }
      if (anyOpen) lanesSeen++;
    }
    return count;
  }

  get totalBuffered(): number {
    let sum = 0;
    for (const lane of this.lanes) for (const channel of lane.channels) sum += channel.bufferedAmount;
    return sum;
  }

  get bufferedAmounts(): number[] {
    return this.channels.map((c) => c.bufferedAmount);
  }

  get isOpen(): boolean {
    if (this.closed) return false;
    const primary = this.lanes.find((l) => l.id === '0') ?? this.lanes[0];
    return !!primary && primary.channels.some((c) => c.readyState === 'open');
  }

  get canSend(): boolean {
    return this.totalBuffered < this.highWatermark;
  }

  setActiveLanes(count: number): void {
    this.activeLanes = Math.max(1, count);
    this.applyThresholds();
  }

  setActiveChannelsPerLane(count: number): void {
    this.channelsPerPrimaryLane = Math.max(1, Math.min(CHANNEL_COUNT, count));
    this.applyThresholds();
  }

  setSchedulePolicy(policy: SchedulePolicy): void {
    this.schedulePolicy = policy;
  }

  setHighWatermark(bytes: number): void {
    const minWatermark = Math.max(bytes, this.openLaneCount * 4 * 1024 * 1024);
    this.highWatermark = minWatermark;
    this.applyThresholds();
    if (this.totalBuffered <= this.resumeLevel) this.handleLow();
  }

  /** Sends one frame on the selected open channel of the active lanes. Returns false if nothing is open. */
  send(frame: ArrayBuffer | Uint8Array<ArrayBuffer>): boolean {
    const candidates: RTCDataChannel[] = [];
    let best: RTCDataChannel | null = null;
    let lanesSeen = 0;
    const laneLimit = Number.isFinite(this.activeLanes) ? this.activeLanes : this.lanes.length;

    for (const lane of this.lanes) {
      if (lanesSeen >= laneLimit) break;
      const limit = lane.id === '0' ? Math.min(lane.channels.length, this.channelsPerPrimaryLane) : lane.channels.length;
      let laneOpen = false;
      for (let i = 0; i < limit; i++) {
        const channel = lane.channels[i];
        if (channel.readyState !== 'open') continue;
        laneOpen = true;
        if (this.schedulePolicy === 'round-robin') {
          candidates.push(channel);
        } else if (!best || channel.bufferedAmount < best.bufferedAmount) {
          best = channel;
        }
      }
      if (laneOpen) lanesSeen++;
    }

    if (this.schedulePolicy === 'round-robin') {
      if (candidates.length === 0) return false;
      best = candidates[this.rrCursor % candidates.length];
      this.rrCursor = (this.rrCursor + 1) >>> 0;
    }

    if (!best) return false;
    if (frame instanceof Uint8Array) {
      best.send(frame);
    } else {
      best.send(frame);
    }
    this.sentBytes += frame.byteLength;
    if (this.valveOpen && this.totalBuffered >= this.highWatermark) {
      this.setValve(false);
      this.scheduleRecheck();
    }
    return true;
  }

  /** Aggregate level at which the valve re-opens. */
  get resumeLevel(): number {
    return Math.floor(this.highWatermark / 2);
  }

  /** Resolves when the aggregate buffer drains below the resume level (or the pool closes). */
  waitForDrain(): Promise<void> {
    if (this.closed || this.totalBuffered <= this.resumeLevel) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
      this.scheduleRecheck();
    });
  }

  /** Resolves once every queued byte has left the browser send buffers. */
  async flush(): Promise<void> {
    while (!this.closed && this.totalBuffered > 0) {
      await new Promise((r) => setTimeout(r, 12));
    }
  }

  onValve(listener: (open: boolean) => void): () => void {
    this.valveListeners.add(listener);
    return () => this.valveListeners.delete(listener);
  }

  dispose(): void {
    this.closed = true;
    for (const lane of [...this.lanes]) this.removeLane(lane.id);
    if (this.recheckTimer !== null) clearTimeout(this.recheckTimer);
    this.releaseWaiters();
  }

  private applyThresholds(): void {
    let activeChannels = 0;
    const laneCap = Number.isFinite(this.activeLanes) ? this.activeLanes : this.lanes.length;
    for (let i = 0; i < Math.min(laneCap, this.lanes.length); i++) {
      const lane = this.lanes[i];
      activeChannels +=
        lane.id === '0' ? Math.min(lane.channels.length, this.channelsPerPrimaryLane) : lane.channels.length;
    }
    const low = lowWatermarkFor(this.highWatermark, Math.max(1, activeChannels));
    for (const lane of this.lanes) for (const channel of lane.channels) channel.bufferedAmountLowThreshold = low;
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
    if (!this.closed && this.totalBuffered > this.resumeLevel) {
      if (!this.valveOpen || this.drainWaiters.length > 0) this.scheduleRecheck();
      return;
    }
    if (!this.valveOpen) this.setValve(true);
    this.releaseWaiters();
  };

  private scheduleRecheck(): void {
    if (this.recheckTimer !== null || this.closed) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      this.recheckPolls++;
      if (this.valveOpen && this.drainWaiters.length === 0) return;
      this.handleLow();
    }, 8);
  }

  private handleClose = (): void => {
    const primary = this.lanes.find((l) => l.id === '0');
    if (!primary || primary.channels.every((c) => c.readyState === 'closed' || c.readyState === 'closing')) {
      this.closed = true;
      this.releaseWaiters();
    }
  };
}
