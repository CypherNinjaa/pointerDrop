import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { formatBytes, HIGH_WATERMARK, LOW_WATERMARK, type IceRoute } from '../engine/protocol';
import type { TelemetryHUDState } from '../engine/webrtc';

export interface EngineerHUDProps {
  hud: TelemetryHUDState;
  compact: boolean;
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
    label: 'Relayed [typ relay]',
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

export const EngineerHUD: React.FC<EngineerHUDProps> = ({ hud, compact }) => {
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
  const perChannelCap = HIGH_WATERMARK / 4; // 1 MB visual gauge ceiling per channel (4 MB aggregate watermark)

  const compressionText =
    hud.compressionRatio !== null
      ? `LZ4 ${hud.compressionRatio.toFixed(1)}×`
      : hud.compressed
        ? 'LZ4 On'
        : hud.lz4Ready
          ? 'LZ4 Ready'
          : 'Raw';

  return (
    <aside
      aria-label="Network telemetry HUD"
      className={`z-30 mx-auto w-full ${compact ? 'max-w-full' : 'max-w-[680px]'}`}
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
            <span className="shrink-0 text-white/20" aria-hidden="true">·</span>
            <span className={`truncate font-mono text-[11px] font-medium ${routeInfo.colorClass}`}>
              {compact ? routeInfo.short : routeInfo.label}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <span className="tabular-nums font-mono text-[11px] text-ink-secondary">
              {hud.rttMs !== null ? `${hud.rttMs.toFixed(1)} ms` : '— ms'}
            </span>

            {!compact && (
              <span className="rounded-full border border-white/12 bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-ink-secondary">
                {compressionText}
              </span>
            )}

            {/* Mini 4-channel queue meter */}
            <div className="flex items-end gap-0.5 h-3.5" aria-hidden="true" title="4x DataChannel send queues">
              {hud.channelBufferedBytes.map((bytes, idx) => {
                const active = idx < hud.activeChannels;
                const fill = Math.min(1, bytes / perChannelCap);
                const heightPct = active ? Math.max(24, Math.round(fill * 100)) : 18;
                return (
                  <span
                    key={idx}
                    style={{ height: `${heightPct}%` }}
                    className={`w-1 rounded-full ${
                      !active
                        ? 'bg-white/15'
                        : fill > 0.85
                          ? 'bg-amber-system'
                          : bytes > 0
                            ? 'bg-lime-signal'
                            : 'bg-cyan-warp/70'
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
                  <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">Throughput</div>
                  <div className="tabular-nums mt-0.5 font-mono text-sm font-semibold text-ink-primary">
                    {hud.throughputMBps.toFixed(1)} MB/s
                  </div>
                </div>

                <div className="calm-row rounded-xl p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">Link RTT</div>
                  <div className="tabular-nums mt-0.5 font-mono text-sm font-semibold text-ink-primary">
                    {hud.rttMs !== null ? `${hud.rttMs.toFixed(1)} ms` : '—'}
                  </div>
                </div>

                <div className="calm-row rounded-xl p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">Jumbo Frame</div>
                  <div className="tabular-nums mt-0.5 font-mono text-sm font-semibold text-ink-primary">
                    {Math.round(hud.chunkSize / 1024)} KB
                    {hud.degraded && <span className="ml-1 text-[10px] text-amber-system">(Throttled)</span>}
                  </div>
                </div>

                <div className="calm-row rounded-xl p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">Compression</div>
                  <div className="tabular-nums mt-0.5 font-mono text-sm font-semibold text-ink-primary">
                    {compressionText}
                  </div>
                </div>
              </div>

              {/* 3-Tier ICE Cascade Topology Indicator */}
              <div className="mt-2.5 calm-row rounded-xl p-2.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-medium text-ink-secondary">3-Tier ICE Cascade</span>
                  <span className="font-mono text-[10px] text-ink-tertiary">
                    {hud.protocol ? hud.protocol.toUpperCase() : 'SCTP/DTLS'} · {hud.connectionState}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1.5 text-center font-mono text-[10px]">
                  <div
                    className={`rounded-lg border px-2 py-1 ${
                      hud.route === 'host'
                        ? 'border-lime-signal/60 bg-lime-signal/15 text-lime-signal font-semibold'
                        : 'border-white/10 bg-white/[0.02] text-ink-tertiary'
                    }`}
                  >
                    T1 · typ host
                  </div>
                  <div
                    className={`rounded-lg border px-2 py-1 ${
                      hud.route === 'srflx'
                        ? 'border-cyan-ice/60 bg-cyan-ice/15 text-cyan-ice font-semibold'
                        : 'border-white/10 bg-white/[0.02] text-ink-tertiary'
                    }`}
                  >
                    T2 · typ srflx
                  </div>
                  <div
                    className={`rounded-lg border px-2 py-1 ${
                      hud.route === 'relay'
                        ? 'border-amber-system/60 bg-amber-system/15 text-amber-system font-semibold'
                        : 'border-white/10 bg-white/[0.02] text-ink-tertiary'
                    }`}
                  >
                    T3 · typ relay
                  </div>
                </div>
              </div>

              {/* 4x Unordered RTCDataChannel Queue Depths & Watermark Valve */}
              <div className="mt-2.5 calm-row rounded-xl p-2.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-medium text-ink-secondary">
                    4× Unordered DataChannels ({hud.activeChannels}/4 active)
                  </span>
                  <span className="tabular-nums font-mono text-[10px] text-ink-tertiary">
                    {formatBytes(totalBuffered, 0)} / {formatBytes(HIGH_WATERMARK, 0)} High WM · Low {formatBytes(LOW_WATERMARK, 0)}
                  </span>
                </div>

                <div className="mt-2 grid grid-cols-4 gap-2">
                  {hud.channelBufferedBytes.map((bytes, idx) => {
                    const active = idx < hud.activeChannels;
                    const pct = Math.min(100, Math.round((bytes / perChannelCap) * 100));
                    return (
                      <div key={idx} className="flex flex-col gap-1">
                        <div className="flex items-center justify-between font-mono text-[10px]">
                          <span className={active ? 'text-ink-secondary' : 'text-ink-tertiary'}>Ch {idx}</span>
                          <span className="tabular-nums text-ink-tertiary">{formatBytes(bytes, 0)}</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                          <div
                            style={{ width: `${pct}%` }}
                            className={`h-full rounded-full transition-[width] duration-150 ${
                              !active
                                ? 'bg-white/20'
                                : pct > 85
                                  ? 'bg-amber-system'
                                  : 'bg-lime-signal'
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
                  Worker: {hud.workerMode === 'native-worker-dc' ? 'Native Transferable DC' : 'Zero-Copy Transferable ArrayBuffer'}
                </span>
                <span>
                  WASM LZ4: {hud.lz4Ready ? 'Active' : 'Fallback'} · OPFS Sink: {hud.opfsReady ? 'SyncAccessHandle' : 'Memory'}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </aside>
  );
};
