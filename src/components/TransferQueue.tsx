import React from 'react';
import { formatBytes, type SinkKind } from '../engine/protocol';
import type { TransferRecord } from '../engine/webrtc';
import { GlassCard } from './GlassCard';

export interface TransferQueueProps {
  transfers: TransferRecord[];
  compact: boolean;
  onAccept: (transferId: string) => void;
  onDecline: (transferId: string) => void;
  onPause: (transferId: string) => void;
  onResume: (transferId: string) => void;
  onCancel: (transferId: string) => void;
  onClearFinished: () => void;
}

function describeStatus(tr: TransferRecord): string {
  switch (tr.status) {
    case 'analyzing':
      return 'Sampling 64 KB Shannon entropy & system budget…';
    case 'connecting':
      return 'Negotiating WebRTC blast + reliable channels…';
    case 'offering':
      return `Waiting for ${tr.peerName} to accept`;
    case 'offered':
      return `${tr.peerName} wants to share a file pointer`;
    case 'transferring':
      return tr.direction === 'send' ? `Streaming to ${tr.peerName}` : `Pulling from ${tr.peerName}`;
    case 'flushing':
      return 'Verifying 16 KB block bitmap & flushing to storage…';
    case 'paused':
      return 'Transfer paused';
    case 'completed':
      return tr.direction === 'receive'
        ? tr.savedVia === 'filesystem-handle'
          ? 'Written directly to chosen OS file'
          : tr.sink === 'ram-arena'
            ? 'Received in RAM Turbo Arena & saved'
            : 'Saved via OPFS stream download'
        : `Delivered to ${tr.peerName}`;
    case 'declined':
      return 'Offer declined';
    case 'cancelled':
      return tr.errorMessage || 'Transfer cancelled';
    case 'failed':
      return tr.errorMessage || 'Transfer interrupted';
  }
}

function sinkBadgeLabel(sink: SinkKind): string {
  switch (sink) {
    case 'ram-arena':
      return 'RAM Turbo';
    case 'direct-handle':
      return 'Direct Disk';
    case 'opfs-sync':
      return 'OPFS Sync';
    case 'opfs-writable':
      return 'OPFS Stream';
    case 'memory':
      return 'Bounded RAM';
    case 'discard':
      return 'Discard';
  }
}

function formatEta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `Est. ${seconds}s left`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `Est. ${mins}m ${rem}s left`;
}

export const TransferQueue: React.FC<TransferQueueProps> = ({
  transfers,
  compact,
  onAccept,
  onDecline,
  onPause,
  onResume,
  onCancel,
  onClearFinished,
}) => {
  if (transfers.length === 0) return null;

  const hasFinished = transfers.some(
    (t) => t.status === 'completed' || t.status === 'declined' || t.status === 'cancelled' || t.status === 'failed',
  );

  return (
    <GlassCard as="section" aria-label="File transfers" padding={compact ? 'sm' : 'md'}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-ink-primary">
          Transfers <span className="tabular-nums text-ink-tertiary">({transfers.length})</span>
        </h2>
        {hasFinished && (
          <button
            type="button"
            onClick={onClearFinished}
            className="warp-btn text-xs font-medium text-ink-secondary hover:text-white"
          >
            Clear Finished
          </button>
        )}
      </div>

      <ul className="mt-3 max-h-[340px] space-y-2.5 overflow-y-auto pr-0.5">
        {transfers.map((tr) => {
          const pct = tr.fileSize > 0 ? Math.min(100, Math.round((tr.bytesTransferred / tr.fileSize) * 100)) : 0;
          const etaLabel = formatEta(tr.etaSeconds);
          const isIncomingOffer = tr.status === 'offered' && tr.direction === 'receive';
          const isActive = tr.status === 'transferring' || tr.status === 'flushing';

          return (
            <li
              key={tr.id}
              className={`calm-row rounded-2xl p-3 ${
                isIncomingOffer ? 'border-cyan-ice/45 bg-cyan-warp/[0.11]' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                        tr.direction === 'send'
                          ? 'bg-cyan-warp/20 text-cyan-ice'
                          : 'bg-lime-signal/20 text-lime-signal'
                      }`}
                    >
                      {tr.direction === 'send' ? 'Out' : 'In'}
                    </span>
                    <span className="truncate text-xs font-semibold text-ink-primary" title={tr.fileName}>
                      {tr.fileName}
                    </span>
                  </div>

                  <p className="mt-1 text-[11px] text-ink-secondary">{describeStatus(tr)}</p>
                </div>

                <span className="tabular-nums shrink-0 font-mono text-xs text-ink-secondary">
                  {formatBytes(tr.fileSize)}
                </span>
              </div>

              {/* Technical Badges: Transport, Entropy, Compression, Dynamic Chunk/Lanes, Sink, Route, Integrity */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-ink-tertiary">
                <span
                  className={`rounded border px-1.5 py-0.5 ${
                    tr.transport === 'lan-turbo'
                      ? 'border-lime-signal/60 bg-lime-signal/20 text-lime-signal font-semibold'
                      : tr.transport === 'local-bus'
                        ? 'border-purple-400/50 bg-purple-500/15 text-purple-300 font-semibold'
                        : tr.transport === 'blast-nack'
                          ? 'border-lime-signal/35 bg-lime-signal/10 text-lime-signal'
                          : 'border-cyan-ice/30 bg-cyan-warp/12 text-cyan-ice'
                  }`}
                >
                  {tr.transport === 'lan-turbo'
                    ? '⚡ LAN Turbo'
                    : tr.transport === 'local-bus'
                      ? '⚡ Memory Bus'
                      : tr.transport === 'blast-nack'
                        ? 'Blast+NACK'
                        : 'Rel-SCTP'}
                </span>
                <span className="rounded border border-white/10 bg-black/35 px-1.5 py-0.5">
                  H={tr.entropy.toFixed(2)} b/B
                </span>
                <span className="rounded border border-white/10 bg-black/35 px-1.5 py-0.5">
                  {tr.compressed
                    ? tr.compressionRatio
                      ? `LZ4 ${tr.compressionRatio.toFixed(2)}×`
                      : 'LZ4 Stream'
                    : 'Raw Stream'}
                </span>
                {(isActive || tr.status === 'completed') && (
                  <span className="tabular-nums rounded border border-white/10 bg-black/35 px-1.5 py-0.5">
                    {Math.round(tr.chunkSize / 1024)}K · {tr.activeLanes}L
                  </span>
                )}
                {tr.sink && tr.sink !== 'discard' && (
                  <span
                    className={`rounded border px-1.5 py-0.5 ${
                      tr.sink === 'ram-arena' || tr.sink === 'direct-handle'
                        ? 'border-cyan-ice/35 bg-cyan-warp/12 text-cyan-ice'
                        : 'border-white/10 bg-black/35'
                    }`}
                  >
                    {sinkBadgeLabel(tr.sink)}
                  </span>
                )}
                {tr.route !== 'unknown' && (
                  <span
                    className={`rounded border px-1.5 py-0.5 ${
                      tr.route === 'host'
                        ? 'border-lime-signal/35 text-lime-signal'
                        : tr.route === 'srflx'
                          ? 'border-cyan-ice/35 text-cyan-ice'
                          : 'border-amber-system/35 text-amber-system'
                    }`}
                    title={tr.candidatePairLabel}
                  >
                    {tr.candidatePairLabel && tr.candidatePairLabel !== 'standby'
                      ? tr.candidatePairLabel
                      : `typ ${tr.route}`}
                  </span>
                )}
                {tr.status === 'completed' && tr.integrityVerified && (
                  <span className="rounded border border-lime-signal/40 bg-lime-signal/12 px-1.5 py-0.5 text-lime-signal">
                    Hash Verified ✓
                  </span>
                )}
              </div>

              {/* Incoming Offer Explicit Consent Controls */}
              {isIncomingOffer && (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onAccept(tr.id)}
                    className="warp-btn warp-btn-primary flex-1 rounded-xl bg-cyan-warp px-3.5 py-2 text-xs font-semibold text-white"
                  >
                    Pull File
                  </button>
                  <button
                    type="button"
                    onClick={() => onDecline(tr.id)}
                    className="warp-btn warp-btn-subtle rounded-xl border border-white/18 bg-white/[0.06] px-3.5 py-2 text-xs font-medium text-ink-primary"
                  >
                    Decline
                  </button>
                </div>
              )}

              {/* Determinate Progress + Live Telemetry + Controls */}
              {(isActive || tr.status === 'paused' || tr.status === 'completed') && (
                <div className="mt-2.5">
                  <div
                    role="progressbar"
                    aria-label={`Transfer progress for ${tr.fileName}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={tr.status === 'completed' ? 100 : pct}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
                  >
                    <div
                      style={{ width: `${tr.status === 'completed' ? 100 : pct}%` }}
                      className={`h-full rounded-full transition-[width] duration-150 ${
                        tr.status === 'paused' ? 'bg-amber-system' : 'bg-lime-signal'
                      }`}
                    />
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-secondary">
                    <span className="tabular-nums font-mono">
                      {formatBytes(tr.bytesTransferred)} / {formatBytes(tr.fileSize)} (
                      {tr.status === 'completed' ? 100 : pct}%)
                    </span>

                    <div className="flex items-center gap-2">
                      {tr.throughputMBps !== null && tr.throughputMBps > 0 && (
                        <span className="tabular-nums font-mono text-lime-signal">
                          {tr.throughputMBps.toFixed(1)} MB/s
                        </span>
                      )}
                      {etaLabel && <span className="tabular-nums text-ink-tertiary">{etaLabel}</span>}
                    </div>
                  </div>
                </div>
              )}

              {/* Active / Offering / Paused Action Controls */}
              {(tr.status === 'transferring' ||
                tr.status === 'paused' ||
                tr.status === 'offering' ||
                tr.status === 'connecting') && (
                <div className="mt-2.5 flex items-center justify-end gap-2">
                  {tr.status === 'transferring' && (
                    <button
                      type="button"
                      onClick={() => onPause(tr.id)}
                      className="warp-btn warp-btn-subtle rounded-lg border border-white/15 bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-ink-primary"
                    >
                      Pause
                    </button>
                  )}
                  {tr.status === 'paused' && (
                    <button
                      type="button"
                      onClick={() => onResume(tr.id)}
                      className="warp-btn warp-btn-primary rounded-lg bg-cyan-warp px-2.5 py-1 text-[11px] font-semibold text-white"
                    >
                      Resume
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onCancel(tr.id)}
                    className="warp-btn rounded-lg border border-danger/35 bg-danger/12 px-2.5 py-1 text-[11px] font-medium text-danger hover:bg-danger/20"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </GlassCard>
  );
};
