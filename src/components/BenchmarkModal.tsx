import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  formatSuiteMarkdownReport,
  type BenchmarkPresetId,
  type BenchmarkRunResult,
  type BenchmarkSuiteSummary,
  type BenchmarkUserMetadata,
} from '../engine/benchmark';
import { formatBytes } from '../engine/protocol';
import type { PeerPresence } from '../engine/signaling';
import type { TelemetryHUDState } from '../engine/webrtc';

export interface BenchmarkModalProps {
  open: boolean;
  peers: PeerPresence[];
  selectedPeerId: string | null;
  hud: TelemetryHUDState;
  compact: boolean;
  onClose: () => void;
  onRunSuite: (
    peerId: string,
    peerName: string,
    preset: BenchmarkPresetId,
    meta: BenchmarkUserMetadata,
    onProgress: (p: {
      stepIndex: number;
      totalSteps: number;
      stepLabel: string;
      completed: BenchmarkRunResult[];
    }) => void,
  ) => Promise<BenchmarkSuiteSummary>;
  onCancelSuite: () => void;
}

const PRESETS: Array<{
  id: BenchmarkPresetId;
  title: string;
  badge: string;
  desc: string;
}> = [
  {
    id: 'quick-autotune',
    title: 'Quick Link & Autotune',
    badge: '~6s · P0',
    desc: 'Warm-up + dynamic hill-climb across 16–256 KiB chunks & parallel SCTP lanes. Seeds optimal config.',
  },
  {
    id: 'repeat-3x',
    title: '3× Repeatable Median',
    badge: '~12s · P0',
    desc: 'Warm-up + 3 incompressible runs with OPFS persistence, median MB/s, p95 spread & 128-bit hash check.',
  },
  {
    id: 'chunk-sweep',
    title: 'Chunk Sweep (16–256 KiB)',
    badge: '~14s · P3',
    desc: 'Compares every SCTP-supported frame size + measures control-channel ping latency under bulk load.',
  },
  {
    id: 'channel-lane-sweep',
    title: 'Channel & SCTP Lane Sweep',
    badge: '~15s · P4',
    desc: 'Tests 1, 2, 4 channels, least-buffered vs round-robin scheduling, and parallel RTCPeerConnection lanes.',
  },
  {
    id: 'worker-vs-bridge',
    title: 'Worker DC vs UI Bridge',
    badge: '~8s · P2',
    desc: 'Directly compares native worker-owned RTCDataChannels against transferable ArrayBuffer bridge handoffs.',
  },
  {
    id: 'sink-and-lz4',
    title: 'OPFS Sinks & LZ4 Audit',
    badge: '~13s · P1/P6',
    desc: 'Compares Network Discard vs OPFS Sync vs Bounded Async OPFS (8 MiB credit cap) + Raw vs WASM LZ4.',
  },
];

const NETWORK_OPTIONS = [
  'Same Router Wi-Fi 5/6',
  'Same Router Wi-Fi 2.4 GHz',
  'Ethernet LAN',
  'Cross-Network / WAN',
  'Mobile Hotspot / 5G',
  'Same-Device Loopback',
];

const POWER_OPTIONS = ['Plugged In', 'On Battery', 'Low Power / Saver'];

export const BenchmarkModal: React.FC<BenchmarkModalProps> = ({
  open,
  peers,
  selectedPeerId,
  hud,
  compact,
  onClose,
  onRunSuite,
  onCancelSuite,
}) => {
  const reduceMotion = useReducedMotion();
  const [targetPeerId, setTargetPeerId] = useState<string>('');
  const [preset, setPreset] = useState<BenchmarkPresetId>('quick-autotune');
  const [networkTag, setNetworkTag] = useState<string>(NETWORK_OPTIONS[0]);
  const [powerTag, setPowerTag] = useState<string>(POWER_OPTIONS[0]);

  const [running, setRunning] = useState<boolean>(false);
  const [progress, setProgress] = useState<{
    stepIndex: number;
    totalSteps: number;
    stepLabel: string;
    completed: BenchmarkRunResult[];
  } | null>(null);
  const [summary, setSummary] = useState<BenchmarkSuiteSummary | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedKind, setCopiedKind] = useState<'md' | 'json' | null>(null);

  useEffect(() => {
    if (!open) return;
    const preferred =
      (selectedPeerId && peers.some((p) => p.id === selectedPeerId) ? selectedPeerId : null) ??
      (hud.activeLinkPeerId && peers.some((p) => p.id === hud.activeLinkPeerId) ? hud.activeLinkPeerId : null) ??
      peers[0]?.id ??
      '';
    setTargetPeerId(preferred);
  }, [open, peers, selectedPeerId, hud.activeLinkPeerId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, running, onClose]);

  const activePeer = peers.find((p) => p.id === targetPeerId) ?? peers[0] ?? null;

  const handleRun = async () => {
    if (!activePeer || running) return;
    setRunning(true);
    setErrorMsg(null);
    setSummary(null);
    setProgress({ stepIndex: 0, totalSteps: 1, stepLabel: 'Connecting & probing peer link…', completed: [] });
    try {
      const result = await onRunSuite(
        activePeer.id,
        activePeer.name,
        preset,
        { networkTag, powerTag },
        (next) => setProgress(next),
      );
      setSummary(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancelled/i.test(msg)) setErrorMsg(msg);
    } finally {
      setRunning(false);
    }
  };

  const handleCopy = async (kind: 'md' | 'json') => {
    if (!summary) return;
    const payload = kind === 'md' ? formatSuiteMarkdownReport(summary) : JSON.stringify(summary, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedKind(kind);
      setTimeout(() => setCopiedKind(null), 2000);
    } catch {
      // Clipboard blocked
    }
  };

  const visibleRuns = summary?.runs ?? progress?.completed ?? [];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="warp-bench-title"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-md sm:p-5"
          onClick={(e) => {
            if (e.target === e.currentTarget && !running) onClose();
          }}
        >
          <motion.div
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 6 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            className="glass-surface flex max-h-[92vh] w-full max-w-[920px] flex-col overflow-hidden rounded-glass"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3.5 sm:px-6">
              <div>
                <h2 id="warp-bench-title" className="text-sm font-semibold tracking-tight text-white sm:text-base">
                  Link Diagnostics & Autotune Benchmark
                </h2>
                <p className="text-[11px] text-ink-secondary">
                  Measures true ICE route evidence, WebRTC getStats() wire bytes, SCTP queue wait, OPFS write speed & 128-bit integrity.
                </p>
              </div>
              <button
                type="button"
                disabled={running}
                onClick={onClose}
                className="warp-btn warp-btn-subtle shrink-0 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-xs font-medium text-ink-secondary hover:text-white disabled:opacity-40"
              >
                Close
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
              {!hud.secureContext && (
                <div className="rounded-2xl border border-amber-system/40 bg-amber-system/12 px-3.5 py-2.5 text-xs text-amber-system">
                  <strong>Insecure HTTP Origin Detected:</strong> Browsers disable zero-RAM OPFS disk streaming over plain{' '}
                  <code>http://192.168.x.x</code>. Network benchmarks still work via DiscardSink, but for multi-GB file
                  transfers use <code>npm run dev:https</code> or the HTTPS GitHub Pages URL.
                </div>
              )}

              {/* Target Peer & Test Metadata */}
              <div className={`grid gap-3 ${compact ? 'grid-cols-1' : 'sm:grid-cols-3'}`}>
                <label className="calm-row flex flex-col gap-1 rounded-2xl p-3">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-ink-tertiary">
                    Target Peer
                  </span>
                  {peers.length > 0 ? (
                    <select
                      value={activePeer?.id ?? ''}
                      disabled={running}
                      onChange={(e) => setTargetPeerId(e.target.value)}
                      className="rounded-lg border border-white/15 bg-black/60 px-2.5 py-1.5 text-xs font-medium text-white"
                    >
                      {peers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.route !== 'unknown' ? `typ ${p.route}` : p.connectionState})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="py-1.5 text-xs text-amber-system">
                      No peer connected — pair a device on Radar first
                    </span>
                  )}
                </label>

                <label className="calm-row flex flex-col gap-1 rounded-2xl p-3">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-ink-tertiary">
                    Network Condition (Report Tag)
                  </span>
                  <select
                    value={networkTag}
                    disabled={running}
                    onChange={(e) => setNetworkTag(e.target.value)}
                    className="rounded-lg border border-white/15 bg-black/60 px-2.5 py-1.5 text-xs text-white"
                  >
                    {NETWORK_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="calm-row flex flex-col gap-1 rounded-2xl p-3">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-ink-tertiary">
                    Device Power Mode (Report Tag)
                  </span>
                  <select
                    value={powerTag}
                    disabled={running}
                    onChange={(e) => setPowerTag(e.target.value)}
                    className="rounded-lg border border-white/15 bg-black/60 px-2.5 py-1.5 text-xs text-white"
                  >
                    {POWER_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Preset Selector Grid */}
              <div className={`grid gap-2.5 ${compact ? 'grid-cols-1' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
                {PRESETS.map((item) => {
                  const active = preset === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={running}
                      onClick={() => setPreset(item.id)}
                      className={`warp-btn flex flex-col justify-between rounded-2xl border p-3 text-left ${
                        active
                          ? 'border-cyan-ice/60 bg-cyan-warp/18 text-white'
                          : 'border-white/10 bg-white/[0.03] text-ink-primary hover:border-white/20'
                      } disabled:opacity-50`}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-xs font-semibold">{item.title}</span>
                        <span className="shrink-0 rounded-full border border-white/15 bg-black/40 px-2 py-0.5 font-mono text-[10px] text-cyan-ice">
                          {item.badge}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-snug text-ink-secondary">{item.desc}</p>
                    </button>
                  );
                })}
              </div>

              {/* Action Bar & Live Progress */}
              <div className="calm-row flex flex-wrap items-center justify-between gap-3 rounded-2xl p-3.5">
                <div className="min-w-0 flex-1">
                  {running && progress ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate font-medium text-white">
                          Step {Math.min(progress.stepIndex + 1, progress.totalSteps)}/{progress.totalSteps}:{' '}
                          <span className="text-cyan-ice">{progress.stepLabel}</span>
                        </span>
                        <span className="tabular-nums shrink-0 font-mono text-xs text-lime-signal">
                          {hud.throughputMBps > 0 ? `${hud.throughputMBps.toFixed(1)} MB/s` : 'measuring…'}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                          style={{
                            width: `${Math.max(8, Math.round((progress.stepIndex / Math.max(1, progress.totalSteps)) * 100))}%`,
                          }}
                          className="h-full rounded-full bg-cyan-warp transition-[width] duration-200"
                        />
                      </div>
                      {hud.tuner && (
                        <div className="truncate font-mono text-[10px] text-ink-tertiary">
                          Autotuner ({hud.tuner.phase}): {hud.tuner.lastDecision} · Bottleneck: {hud.tuner.bottleneck}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-ink-secondary">
                      {summary
                        ? 'Suite complete — optimal chunk size, lane count & BDP watermark have been applied to this peer link.'
                        : 'Select a diagnostic preset above to measure real bottlenecks without touching user files.'}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {running ? (
                    <button
                      type="button"
                      onClick={onCancelSuite}
                      className="warp-btn rounded-full border border-danger/45 bg-danger/18 px-4 py-2 text-xs font-semibold text-danger hover:bg-danger/25"
                    >
                      Stop Benchmark
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!activePeer}
                      onClick={() => void handleRun()}
                      className="warp-btn warp-btn-primary rounded-full bg-cyan-warp px-5 py-2 text-xs font-semibold text-white disabled:opacity-40"
                    >
                      Run Benchmark
                    </button>
                  )}
                </div>
              </div>

              {errorMsg && (
                <div className="rounded-2xl border border-danger/40 bg-danger/12 px-3.5 py-2.5 text-xs text-danger">
                  Benchmark failed: {errorMsg}
                </div>
              )}

              {/* Summary Cards */}
              {summary && (
                <div className="space-y-3">
                  <div className={`grid gap-2.5 ${compact ? 'grid-cols-2' : 'sm:grid-cols-4'}`}>
                    <div className="calm-row rounded-2xl p-3">
                      <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">Median App Speed</div>
                      <div className="tabular-nums mt-0.5 font-mono text-base font-semibold text-lime-signal">
                        {summary.medianMBps.toFixed(1)} MB/s
                      </div>
                      <div className="tabular-nums font-mono text-[10px] text-ink-tertiary">
                        ±{summary.p95VariationPct}% variation
                      </div>
                    </div>

                    <div className="calm-row rounded-2xl p-3">
                      <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">ICE Route Evidence</div>
                      <div className="mt-0.5 truncate font-mono text-xs font-semibold text-cyan-ice">
                        {summary.bestRun?.candidatePairLabel ?? hud.candidatePairLabel}
                      </div>
                      <div className="tabular-nums font-mono text-[10px] text-ink-tertiary">
                        RTT {summary.bestRun?.rttMs ?? '—'} ms · Load {summary.bestRun?.ctrlPingLoadedMs ?? '—'} ms
                      </div>
                    </div>

                    <div className="calm-row rounded-2xl p-3">
                      <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">Optimal Transport</div>
                      <div className="tabular-nums mt-0.5 font-mono text-xs font-semibold text-white">
                        {summary.bestRun
                          ? `${Math.round(summary.bestRun.chunkSize / 1024)} KiB · ${summary.bestRun.activeLanes}L · ${summary.bestRun.activeChannels}ch`
                          : '—'}
                      </div>
                      <div className="font-mono text-[10px] text-ink-tertiary">
                        {summary.bestRun
                          ? `${formatBytes(summary.bestRun.highWatermark, 0)} WM · ${summary.bestRun.bottleneck} limit`
                          : '—'}
                      </div>
                    </div>

                    <div className="calm-row rounded-2xl p-3">
                      <div className="text-[10px] uppercase tracking-wider text-ink-tertiary">128-Bit Block Hash</div>
                      <div
                        className={`mt-0.5 font-mono text-xs font-semibold ${
                          summary.allHashesVerified ? 'text-lime-signal' : 'text-amber-system'
                        }`}
                      >
                        {summary.allHashesVerified ? 'PASS · 100% Verified' : 'Check Step Table'}
                      </div>
                      <div className="font-mono text-[10px] text-ink-tertiary">
                        Zero dropped/corrupt blocks
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCopy('md')}
                      className="warp-btn warp-btn-subtle rounded-full border border-white/16 bg-white/[0.06] px-3.5 py-1.5 text-xs font-medium text-ink-primary"
                    >
                      {copiedKind === 'md' ? 'Copied Markdown ✓' : 'Copy Markdown Report'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopy('json')}
                      className="warp-btn warp-btn-subtle rounded-full border border-white/16 bg-white/[0.06] px-3.5 py-1.5 text-xs font-medium text-ink-secondary hover:text-white"
                    >
                      {copiedKind === 'json' ? 'Copied JSON ✓' : 'Copy Raw JSON'}
                    </button>
                  </div>
                </div>
              )}

              {/* Detailed Per-Step Telemetry Table */}
              {visibleRuns.length > 0 && (
                <div className="calm-row overflow-x-auto rounded-2xl">
                  <table className="w-full min-w-[740px] border-collapse text-left font-mono text-[11px]">
                    <thead>
                      <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-ink-tertiary">
                        <th className="px-3 py-2.5">Step</th>
                        <th className="px-3 py-2.5">ICE Pair</th>
                        <th className="px-3 py-2.5 text-right">App / Wire / Stats</th>
                        <th className="px-3 py-2.5">Chunk · Lanes · Mode</th>
                        <th className="px-3 py-2.5">Wait (Q/Cred/Disk)</th>
                        <th className="px-3 py-2.5">Sink & Write</th>
                        <th className="px-3 py-2.5 text-right">Ping Idle→Load</th>
                        <th className="px-3 py-2.5 text-center">Hash</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {visibleRuns.map((r) => (
                        <tr key={r.id} className={r.warmup ? 'opacity-65' : ''}>
                          <td className="px-3 py-2 font-sans text-xs font-medium text-ink-primary">
                            {r.warmup && (
                              <span className="mr-1.5 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-ink-tertiary">
                                Warm
                              </span>
                            )}
                            {r.label}
                          </td>
                          <td className="px-3 py-2 text-cyan-ice">{r.candidatePairLabel}</td>
                          <td className="tabular-nums px-3 py-2 text-right">
                            <span className="font-semibold text-lime-signal">{r.appMBps.toFixed(1)}</span>
                            <span className="text-ink-tertiary">
                              {' '}
                              / {r.wireMBps.toFixed(1)} / {r.statsWireMBps.toFixed(1)} MB/s
                            </span>
                          </td>
                          <td className="tabular-nums px-3 py-2 text-ink-secondary">
                            {Math.round(r.chunkSize / 1024)}K · {r.activeLanes}L · {r.activeChannels}ch ·{' '}
                            <span className="text-ink-tertiary">
                              {r.workerMode === 'native-worker-dc' ? 'worker-dc' : 'bridge'}
                            </span>
                          </td>
                          <td className="tabular-nums px-3 py-2 text-ink-secondary">
                            {r.queueWaitPct}% / {r.creditWaitPct}% / {r.diskWaitPct}%{' '}
                            <span className="text-ink-tertiary">({r.bottleneck})</span>
                          </td>
                          <td className="tabular-nums px-3 py-2 text-ink-secondary">
                            {r.sink}
                            {r.receiverWriteMBps !== null ? ` (${r.receiverWriteMBps.toFixed(0)} MB/s)` : ''}
                          </td>
                          <td className="tabular-nums px-3 py-2 text-right text-ink-secondary">
                            {r.ctrlPingIdleMs ?? '—'} → {r.ctrlPingLoadedMs ?? '—'} ms
                          </td>
                          <td className="px-3 py-2 text-center">
                            {r.hashMatch ? (
                              <span className="text-lime-signal" title={`128-bit digest ${r.receiverHash}`}>
                                ✓
                              </span>
                            ) : (
                              <span className="text-danger" title="Digest mismatch">
                                ✗
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
