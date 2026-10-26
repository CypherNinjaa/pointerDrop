import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { formatBytes, type IceRoute, type SinkKind } from '../engine/protocol';
import type { TelemetryHUDState } from '../engine/webrtc';

export interface EngineerHUDProps {
  hud: TelemetryHUDState;
  compact: boolean;
  onOpenBenchmark?: () => void;
}

const ROUTE_DESC: Record<IceRoute, { label: string; short: string; colorClass: string; dotClass: string }> = {
  host: {
    label: 'LAN Direct [typ host]',
    short: 'typ host',
    colorClass: 'text-lime-signal',
    dotClass: 'bg-lime-signal',
  },
  srflx: {
    label: 'WAN P2P [typ srflx]',
    short: 'typ srflx',
    colorClass: 'text-cyan-ice',
    dotClass: 'bg-cyan-ice',
  },
  relay: {
    label: 'TURN Relay [typ relay]',
    short: 'typ relay',
    colorClass: 'text-amber-system',
    dotClass: 'bg-amber-system',
  },
  unknown: {
    label: 'Standby · No active link',
    short: 'standby',
    colorClass: 'text-ink-secondary',
    dotClass: 'bg-white/40',
  },
};

function describeSink(sink: SinkKind | null, opfsSyncReady: boolean, opfsReady: boolean, secure: boolean): string {
  if (sink === 'opfs-sync') return 'OPFS SyncAccessHandle';
  if (sink === 'opfs-writable') return 'OPFS Async Writable';
  if (sink === 'memory') return 'Bounded RAM';
  if (sink === 'discard') return 'Benchmark Discard';
  if (opfsSyncReady) return 'OPFS Sync Ready';
  if (opfsReady) return 'OPFS Stream Ready';
  return secure ? 'Bounded RAM' : 'RAM Only (Plain HTTP)';
}

export const EngineerHUD: React.FC<EngineerHUDProps> = ({ hud, compact, onOpenBenchmark }) => {
  const [expanded, setExpanded] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  const routeInfo = ROUTE_DESC[hud.route];
  const totalBuffered = hud.channelBufferedBytes.reduce((acc, b) => acc + b, 0);
  const channelCount = Math.max(1, hud.channelBufferedBytes.length);
  const perChannelCap = Math.max(256 * 1024, hud.highWatermark / Math.max(1, hud.activeChannels || channelCount));

  const compressionText =
    hud.compressionRatio !== null
      ? hud.compressed
        ? `LZ4 ${hud.compressionRatio.toFixed(2)}×`
        : 'Raw Bypass'
      : hud.compressed
        ? 'LZ4 On'
        : hud.lz4Ready
          ? 'LZ4 Ready'
          : 'Raw';

  const pillRouteText =
    hud.route === 'unknown'
      ? compact
        ? routeInfo.short
        : routeInfo.label
      : compact
        ? routeInfo.short
        : `${routeInfo.short} (${hud.candidatePairLabel})`;

  return (
    <aside
      aria-label="Network telemetry HUD"
      className={`z-30 mx-auto w-full ${compact ? 'max-w-full' : 'max-w-[740px]'}`}
    >
      <div className="glass-pill overflow-hidden rounded-[22px]">
        {/* Collapsed Dynamic Island Pill Trigger */}
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-controls="warp-hud-details"
          className="warp-btn flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-xs"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${routeInfo.dotClass}`} aria-hidden="true" />
            <span className="tabular-nums shrink-0 whitespace-nowrap font-mono font-semibold text-ink-primary">
              {hud.throughputMBps > 0 ? `${hud.throughputMBps.toFixed(1)} MB/s` : '0.0 MB/s'}
            </span>
            <span className="shrink-0 text-white/20" aria-hidden="true">
              ·
            </span>
            <span className={`truncate font-mono text-[11px] font-medium ${routeInfo.colorClass}`}>
              {pillRouteText}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            {!compact && (
              <span className="tabular-nums rounded-full border border-white/12 bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] text-ink-secondary">
                {Math.round(hud.chunkSize / 1024)}K · {hud.activeLanes}L
              </span>
            )}

            <span className="tabular-nums font-mono text-[11px] text-ink-secondary">
              {hud.rttMs !== null ? `${hud.rttMs.toFixed(1)} ms` : '— ms'}
            </span>

            {/* Mini channel queue meter (caps at 8 bars in collapsed pill) */}
            <div
              className="flex h-3.5 items-end gap-0.5"
              aria-hidden="true"
              title="Striped DataChannel send queues"
            >
              {hud.channelBufferedBytes.slice(0, 8).map((bytes, idx) => {
                const fill = Math.min(1, bytes / perChannelCap);
                const heightPct = Math.max(22, Math.round(fill * 100));
                return (
                  <span
                    key={idx}
                    style={{ height: `${heightPct}%` }}
                    className={`w-1 rounded-full ${
                      fill > 0.85 ? 'bg-amber-system' : bytes > 0 ? 'bg-lime-signal' : 'bg-cyan-warp/70'
                    }`}
                  />
                );
              })}
            </div>

            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={`text-ink-tertiary transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
            >
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </div>
        </button>

        {/* Expanded Engineer Telemetry Matrix */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              id="warp-hud-details"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
              className="border-t border-white/10 px-4 pb-4 pt-3 text-xs"
            >
              {/* Primary Telemetry Cells */}
              <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-4'}`}>
                <div className="calm-row rounded-xl p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">App / Wire Speed</div>
                  <div className="tabular-nums mt-0.5 font-mono text-sm font-semibold text-ink-primary">
                    {hud.throughputMBps.toFixed(1)} MB/s
                  </div>
                  <div className="tabular-nums font-mono text-[10px] text-ink-tertiary">
                    getStats: {hud.statsWireMBps.toFixed(1)} MB/s
                  </div>
                </div>

                <div className="calm-row rounded-xl p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">Link RTT</div>
                  <div className="tabular-nums mt-0.5 font-mono text-sm font-semibold text-ink-primary">
                    {hud.rttMs !== null ? `${hud.rttMs.toFixed(1)} ms` : '—'}
                  </div>
                  <div className="truncate font-mono text-[10px] text-ink-tertiary">
                    {hud.peerName ? `Peer: ${hud.peerName}` : 'No active peer'}
                  </div>
                </div>

                <div className="calm-row rounded-xl p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">Dynamic Frame & Lanes</div>
                  <div className="tabular-nums mt-0.5 font-mono text-sm font-semibold text-ink-primary">
                    {Math.round(hud.chunkSize / 1024)} KB · {hud.activeLanes}L
                  </div>
                  <div className="tabular-nums font-mono text-[10px] text-ink-tertiary">
                    SCTP max {hud.maxSctpMessageSize ? formatBytes(hud.maxSctpMessageSize, 0) : 'auto'} ·{' '}
                    {hud.connectedLanes} PC
                  </div>
                </div>

                <div className="calm-row rounded-xl p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">Compression</div>
                  <div className="tabular-nums mt-0.5 font-mono text-sm font-semibold text-ink-primary">
                    {compressionText}
                  </div>
                  <div className="font-mono text-[10px] text-ink-tertiary">
                    {hud.receiverPendingBytes > 0
                      ? `Rx queue ${formatBytes(hud.receiverPendingBytes, 0)}`
                      : 'Credit flow ready'}
                  </div>
                </div>
              </div>

              {/* Dynamic Autotuner + Speed Test Action */}
              <div className="calm-row mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl p-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="font-medium text-ink-secondary">Adaptive Transport Tuner</span>
                    {hud.tuner && (
                      <span className="rounded border border-cyan-ice/35 bg-cyan-warp/15 px-1.5 py-0.5 font-mono text-[10px] text-cyan-ice">
                        {hud.tuner.phase} · {hud.tuner.bottleneck}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-ink-tertiary">
                    {hud.tuner
                      ? `${hud.tuner.lastDecision} (Wait Q:${hud.tuner.queueWaitPct}% Cred:${hud.tuner.creditWaitPct}% Disk:${hud.tuner.diskWaitPct}%)`
                      : 'Auto-climbs 16–256 KiB chunks, parallel SCTP lanes & BDP watermarks on every transfer'}
                  </div>
                </div>
                {onOpenBenchmark && (
                  <button
                    type="button"
                    onClick={onOpenBenchmark}
                    className="warp-btn warp-btn-subtle shrink-0 rounded-full border border-cyan-ice/45 bg-cyan-warp/20 px-3 py-1 font-mono text-[11px] font-semibold text-cyan-ice hover:text-white"
                  >
                    Speed Test Lab
                  </button>
                )}
              </div>

              {/* 3-Tier ICE Cascade Topology Indicator */}
              <div className="calm-row mt-2.5 rounded-xl p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <span className="font-medium text-ink-secondary">3-Tier ICE Cascade Evidence</span>
                  <span className="font-mono text-[10px] text-ink-tertiary">
                    {hud.candidatePairLabel} · {hud.connectionState}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1.5 text-center font-mono text-[10px]">
                  <div
                    className={`rounded-lg border px-2 py-1 ${
                      hud.route === 'host'
                        ? 'border-lime-signal/60 bg-lime-signal/15 font-semibold text-lime-signal'
                        : 'border-white/10 bg-white/[0.02] text-ink-tertiary'
                    }`}
                  >
                    T1 · host ↔ host
                  </div>
                  <div
                    className={`rounded-lg border px-2 py-1 ${
                      hud.route === 'srflx'
                        ? 'border-cyan-ice/60 bg-cyan-ice/15 font-semibold text-cyan-ice'
                        : 'border-white/10 bg-white/[0.02] text-ink-tertiary'
                    }`}
                  >
                    T2 · typ srflx
                  </div>
                  <div
                    className={`rounded-lg border px-2 py-1 ${
                      hud.route === 'relay'
                        ? 'border-amber-system/60 bg-amber-system/15 font-semibold text-amber-system'
                        : 'border-white/10 bg-white/[0.02] text-ink-tertiary'
                    }`}
                  >
                    T3 · typ relay
                  </div>
                </div>
              </div>

              {/* Striped Unordered RTCDataChannel Queue Depths & Adaptive BDP Watermark */}
              <div className="calm-row mt-2.5 rounded-xl p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
                  <span className="font-medium text-ink-secondary">
                    Striped Unordered DataChannels ({hud.activeChannels} active across {hud.activeLanes} SCTP{' '}
                    {hud.activeLanes === 1 ? 'lane' : 'lanes'})
                  </span>
                  <span className="tabular-nums font-mono text-[10px] text-ink-tertiary">
                    {formatBytes(totalBuffered, 0)} / {formatBytes(hud.highWatermark, 0)} BDP WM · Low{' '}
                    {formatBytes(hud.lowWatermark, 0)}
                  </span>
                </div>

                <div className="mt-2 grid grid-cols-4 gap-2">
                  {hud.channelBufferedBytes.slice(0, 8).map((bytes, idx) => {
                    const laneTag = hud.channelLaneIds[idx] ?? '0';
                    const pct = Math.min(100, Math.round((bytes / perChannelCap) * 100));
                    return (
                      <div key={idx} className="flex flex-col gap-1">
                        <div className="flex items-center justify-between font-mono text-[10px]">
                          <span className="text-ink-secondary">
                            {laneTag === '0' ? `Ch ${idx}` : `${laneTag}:${idx}`}
                          </span>
                          <span className="tabular-nums text-ink-tertiary">{formatBytes(bytes, 0)}</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                          <div
                            style={{ width: `${pct}%` }}
                            className={`h-full rounded-full transition-[width] duration-150 ${
                              pct > 85 ? 'bg-amber-system' : 'bg-lime-signal'
                            }`}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Engine Runtime Footnote */}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-0.5 font-mono text-[10px] text-ink-tertiary">
                <span>
                  Worker:{' '}
                  {hud.workerMode === 'native-worker-dc'
                    ? 'Worker-Owned DataChannels'
                    : 'Transferable ArrayBuffer Bridge'}
                </span>
                <span>
                  WASM LZ4: {hud.lz4Ready ? 'Active' : 'Off'} · Sink:{' '}
                  {describeSink(hud.sink, hud.opfsSyncReady, hud.opfsReady, hud.secureContext)}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </aside>
  );
};
