import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { formatBytes, type IceRoute, type SinkKind, type TransportMode } from '../engine/protocol';
import type { TelemetryHUDState } from '../engine/webrtc';

export interface EngineerHUDProps {
  hud: TelemetryHUDState;
  compact: boolean;
  onOpenBenchmark?: () => void;
  onChangeTransportMode?: (mode: TransportMode) => void;
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
  if (sink === 'ram-arena') return 'RAM Turbo Arena (Zero-I/O)';
  if (sink === 'direct-handle') return 'Direct OS FileHandle (Zero-OPFS)';
  if (sink === 'opfs-sync') return 'OPFS Sync (2 MiB Coalesced)';
  if (sink === 'opfs-writable') return 'OPFS Stream (2 MiB Coalesced)';
  if (sink === 'memory') return 'Bounded RAM';
  if (sink === 'discard') return 'Benchmark Discard';
  if (opfsSyncReady) return 'RAM Arena + Direct OS Disk Ready';
  if (opfsReady) return 'RAM Arena + OPFS Ready';
  return secure ? 'RAM Turbo Arena Ready' : 'RAM Only (Plain HTTP)';
}

export const EngineerHUD: React.FC<EngineerHUDProps> = ({
  hud,
  compact,
  onOpenBenchmark,
  onChangeTransportMode,
}) => {
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

  const isBlast = hud.activeTransport === 'blast-nack';
  const isTurbo = hud.activeTransport === 'lan-turbo';
  const isLocalBus = hud.activeTransport === 'local-bus';
  const isBloatGuarded = hud.tuner?.bottleneck === 'bufferbloat';

  return (
    <aside
      aria-label="Network telemetry HUD"
      className={`z-30 mx-auto w-full ${compact ? 'max-w-full' : 'max-w-[780px]'}`}
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

          <div className="flex shrink-0 items-center gap-2">
            {!compact && (
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${
                  isTurbo
                    ? 'border-lime-signal/60 bg-lime-signal/20 text-lime-signal shadow-[0_0_12px_rgba(48,209,88,0.25)]'
                    : isLocalBus
                      ? 'border-purple-400/50 bg-purple-500/15 text-purple-300'
                      : isBlast
                        ? 'border-lime-signal/40 bg-lime-signal/12 text-lime-signal'
                        : 'border-cyan-ice/35 bg-cyan-warp/15 text-cyan-ice'
                }`}
              >
                {isTurbo
                  ? '⚡ LAN Turbo TCP'
                  : isLocalBus
                    ? '⚡ Memory Bus'
                    : isBlast
                      ? 'Blast+NACK'
                      : 'Rel-SCTP'}
              </span>
            )}

            {!compact && (
              <span className="tabular-nums rounded-full border border-white/12 bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] text-ink-secondary">
                {Math.round(hud.chunkSize / 1024)}K · {hud.activeLanes}L
              </span>
            )}

            <span
              className={`tabular-nums font-mono text-[11px] ${
                isBloatGuarded ? 'text-amber-system' : 'text-ink-secondary'
              }`}
            >
              {hud.rttMs !== null ? `${hud.rttMs.toFixed(1)} ms` : '— ms'}
            </span>

            {/* Mini channel queue meter */}
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
                  <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">RTT & Bloat Guard</div>
                  <div className="tabular-nums mt-0.5 font-mono text-sm font-semibold text-ink-primary">
                    {hud.rttMs !== null ? `${hud.rttMs.toFixed(1)} ms` : '—'}
                  </div>
                  <div className="truncate font-mono text-[10px] text-ink-tertiary">
                    {hud.tuner
                      ? `min ${hud.tuner.minRttMs.toFixed(1)} ms · +${hud.tuner.bloatMs.toFixed(0)} ms`
                      : hud.peerName
                        ? `Peer: ${hud.peerName}`
                        : 'No active peer'}
                  </div>
                </div>

                <div className="calm-row rounded-xl p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">Transport & Frame</div>
                  <div className="tabular-nums mt-0.5 font-mono text-sm font-semibold text-ink-primary">
                    {Math.round(hud.chunkSize / 1024)} KB · {hud.activeLanes}L
                  </div>
                  <div className="tabular-nums font-mono text-[10px] text-ink-tertiary">
                    {isTurbo
                      ? 'Unencrypted TCP Cut-Through Pipe'
                      : isLocalBus
                        ? 'Zero-Copy Browser Memory Bus'
                        : isBlast
                          ? 'UDP Blast + Bitmap NACK'
                          : 'Reliable Unordered SCTP'}
                    {hud.tuner && hud.tuner.retransmittedBlocks > 0
                      ? ` (${hud.tuner.retransmittedBlocks} blk)`
                      : ''}
                  </div>
                </div>

                <div className="calm-row rounded-xl p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">RAM / Storage Sink</div>
                  <div className="tabular-nums mt-0.5 truncate font-mono text-sm font-semibold text-ink-primary">
                    {hud.sink === 'ram-arena'
                      ? 'RAM Arena'
                      : hud.sink === 'direct-handle'
                        ? 'Direct Disk'
                        : compressionText}
                  </div>
                  <div className="font-mono text-[10px] text-ink-tertiary">
                    {hud.receiverPendingBytes > 0
                      ? `Rx write ${formatBytes(hud.receiverPendingBytes, 0)}`
                      : hud.concurrentTransfers > 1
                        ? `${hud.concurrentTransfers} concurrent streams`
                        : 'Zero-I/O credit ready'}
                  </div>
                </div>
              </div>

              {/* Scanned Sender ↔ Receiver System Hardware & Transport Mode Selector */}
              <div className="calm-row mt-2.5 rounded-xl p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink-secondary">Scanned System & Link Topology</span>
                    <span className="rounded border border-white/12 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-cyan-ice">
                      {hud.topologyLabel}
                    </span>
                  </div>

                  {onChangeTransportMode && (
                    <div
                      role="group"
                      aria-label="Transport engine mode"
                      className="flex items-center gap-0.5 rounded-full border border-white/12 bg-black/45 p-0.5 font-mono text-[10px]"
                    >
                      {(
                        [
                          { id: 'auto', label: 'Auto' },
                          { id: 'lan-turbo', label: 'LAN Turbo' },
                          { id: 'blast-nack', label: 'Blast+NACK' },
                          { id: 'reliable-sctp', label: 'Rel-SCTP' },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => onChangeTransportMode(opt.id)}
                          className={`warp-btn rounded-full px-2 py-0.5 ${
                            hud.transportMode === opt.id
                              ? 'bg-cyan-warp font-semibold text-white'
                              : 'text-ink-tertiary hover:text-white'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-1.5 grid gap-1 font-mono text-[10px] text-ink-tertiary sm:grid-cols-2">
                  <div className="truncate">
                    <span className="text-ink-secondary">Local:</span>{' '}
                    {hud.selfHw
                       ? `${hud.selfHw.summary} · RAM Arena ${formatBytes(hud.selfHw.ramArenaBudget, 0)}`
                      : 'Scanning hardware…'}
                  </div>
                  <div className="truncate">
                    <span className="text-ink-secondary">Peer:</span>{' '}
                    {hud.peerHw
                      ? `${hud.peerHw.summary} · RAM Arena ${formatBytes(hud.peerHw.ramArenaBudget, 0)}`
                      : hud.peerName
                        ? `${hud.peerName} (awaiting handshake)`
                        : 'Pair a peer to scan remote hardware'}
                  </div>
                </div>
              </div>

              {/* Unencrypted LAN Turbo Status & 1-Click Peer Switch */}
              {hud.turboAvailable ? (
                <div className="calm-row mt-2.5 flex items-center justify-between gap-2 rounded-xl border border-lime-signal/30 bg-lime-signal/[0.08] p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-lime-signal shadow-[0_0_8px_#30d158]" />
                    <div>
                      <div className="font-mono text-[11px] font-semibold text-lime-signal">
                        LAN Turbo Pipe Online · Unencrypted TCP Line Rate (150+ MB/s)
                      </div>
                      <div className="font-mono text-[10px] text-ink-tertiary">
                        Zero-copy kernel cut-through stream active. WebRTC UDP encryption overhead eliminated.
                      </div>
                    </div>
                  </div>
                </div>
              ) : hud.peerLanTurboUrl ? (
                <div className="calm-row mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cyan-ice/40 bg-cyan-warp/15 p-2.5">
                  <div>
                    <div className="font-mono text-[11px] font-semibold text-cyan-ice">
                      Peer is running LAN Turbo Host ({hud.peerLanTurboUrl})
                    </div>
                    <div className="font-mono text-[10px] text-ink-tertiary">
                      Switch to peer local HTTP address to unlock 150+ MB/s unencrypted zero-copy transfers.
                    </div>
                  </div>
                  <a
                    href={`${hud.peerLanTurboUrl}${typeof window !== 'undefined' ? window.location.hash : ''}`}
                    target="_blank"
                    rel="noreferrer"
                    className="warp-btn rounded-full border border-cyan-ice/60 bg-cyan-ice/20 px-3 py-1 font-mono text-[11px] font-semibold text-cyan-ice hover:bg-cyan-ice hover:text-black"
                  >
                    Open LAN Turbo URL ↗
                  </a>
                </div>
              ) : (
                <div className="calm-row mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl p-2.5 text-[11px]">
                  <div className="min-w-0 flex-1 font-mono text-[10px] text-ink-tertiary">
                    <span className="font-semibold text-ink-secondary">Speed Tip:</span> Run{' '}
                    <code className="rounded bg-white/10 px-1 py-0.5 text-cyan-ice">npm run turbo</code> on any LAN laptop to bypass browser WebRTC UDP rate caps and achieve 150+ MB/s.
                  </div>
                </div>
              )}

              {/* Dynamic BBR Autotuner + Speed Test Action */}
              <div className="calm-row mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl p-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="font-medium text-ink-secondary">BBR Delay-Aware Autotuner</span>
                    {hud.tuner && (
                      <span
                        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                          isBloatGuarded
                            ? 'border-amber-system/45 bg-amber-system/15 text-amber-system'
                            : 'border-cyan-ice/35 bg-cyan-warp/15 text-cyan-ice'
                        }`}
                      >
                        {hud.tuner.phase} · {hud.tuner.bottleneck}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-ink-tertiary">
                    {hud.tuner
                      ? `${hud.tuner.lastDecision} (Q:${hud.tuner.queueWaitPct}% Cred:${hud.tuner.creditWaitPct}% Disk:${hud.tuner.diskWaitPct}%)`
                      : 'Sizes BDP strictly from minRTT, guards against Wi-Fi TX bufferbloat & repairs dropped 16 KB blocks'}
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
                    Striped DataChannels ({hud.activeChannels} active across {hud.activeLanes}{' '}
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
