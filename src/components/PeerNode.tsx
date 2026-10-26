import React, { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { PeerPresence } from '../engine/signaling';
import type { IceRoute } from '../engine/protocol';

export interface PeerNodeProps {
  peer: PeerPresence;
  x: number;
  y: number;
  compact: boolean;
  isSelected: boolean;
  isSnappedTarget: boolean;
  hasStagedFiles: boolean;
  activeProgress: number | null; // 0..1 when transferring with this peer
  onSelectAndAct: (peer: PeerPresence) => void;
  onDropFiles: (peer: PeerPresence, files: File[]) => void;
}

const ROUTE_LABEL: Record<IceRoute, { short: string; tone: string }> = {
  host: { short: 'LAN', tone: 'text-lime-signal border-lime-signal/40 bg-lime-signal/12' },
  srflx: { short: 'WAN P2P', tone: 'text-cyan-ice border-cyan-ice/40 bg-cyan-ice/12' },
  relay: { short: 'TURN', tone: 'text-amber-system border-amber-system/40 bg-amber-system/12' },
  unknown: { short: 'Ready', tone: 'text-ink-secondary border-white/15 bg-white/5' },
};

const VIA_LABEL: Record<PeerPresence['discoveryVia'], string> = {
  local: 'Local Tab',
  lan: 'Auto-LAN',
  sonic: 'Sonic Drop',
  warp: 'Warp Bridge',
};

function DeviceGlyph({ kind }: { kind: PeerPresence['deviceKind'] }) {
  if (kind === 'mobile') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="7" y="2" width="10" height="20" rx="2.5" />
        <path d="M11 18h2" />
      </svg>
    );
  }
  if (kind === 'extension') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M15 4v16" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M2 20h20" />
    </svg>
  );
}

export const PeerNode: React.FC<PeerNodeProps> = ({
  peer,
  x,
  y,
  compact,
  isSelected,
  isSnappedTarget,
  hasStagedFiles,
  activeProgress,
  onSelectAndAct,
  onDropFiles,
}) => {
  const reduceMotion = useReducedMotion();
  const [isDragOver, setIsDragOver] = useState(false);

  const highlighted = isSnappedTarget || isDragOver;
  const routeBadge =
    peer.route !== 'unknown'
      ? ROUTE_LABEL[peer.route]
      : { short: VIA_LABEL[peer.discoveryVia], tone: 'text-ink-secondary border-white/15 bg-white/5' };

  const avatarSize = compact ? 52 : 62;
  const ringRadius = compact ? 28 : 33;
  const circumference = 2 * Math.PI * ringRadius;

  const handleDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) onDropFiles(peer, dropped);
  };

  const actionDescription = hasStagedFiles
    ? `Send staged file pointer to ${peer.name}`
    : `Choose file to send to ${peer.name}`;

  return (
    <div
      style={{
        left: `${x}px`,
        top: `${y}px`,
      }}
      className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
    >
      <motion.div
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
        animate={
          reduceMotion
            ? { opacity: 1 }
            : {
                opacity: 1,
                scale: highlighted ? 1.07 : 1,
              }
        }
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
        transition={
          reduceMotion
            ? { duration: 0.16 }
            : { type: 'spring', stiffness: 300, damping: 24 }
        }
      >
        <button
          type="button"
          onClick={() => onSelectAndAct(peer)}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          aria-label={`${actionDescription} (${routeBadge.short})`}
          className={`warp-btn group flex flex-col items-center gap-1.5 rounded-2xl px-2.5 py-2 text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-ice ${
            isSelected ? 'bg-white/[0.06]' : ''
          }`}
        >
        <div
          style={{ width: avatarSize, height: avatarSize }}
          className={`relative flex items-center justify-center rounded-full border transition-colors duration-150 ${
            highlighted
              ? 'border-lime-signal bg-lime-signal/20 text-white shadow-[0_0_28px_rgba(48,209,88,0.45)]'
              : isSelected
                ? 'border-cyan-warp bg-cyan-warp/20 text-white shadow-[0_0_24px_rgba(10,132,255,0.35)]'
                : 'glass-pill border-white/20 text-ink-primary group-hover:border-cyan-ice/60'
          }`}
        >
          {/* Determinate circular progress ring during active transfer */}
          {activeProgress !== null && (
            <svg
              width={avatarSize + 12}
              height={avatarSize + 12}
              className="pointer-events-none absolute -inset-1.5 -rotate-90"
              aria-hidden="true"
            >
              <circle
                cx={(avatarSize + 12) / 2}
                cy={(avatarSize + 12) / 2}
                r={ringRadius}
                fill="none"
                stroke="rgba(255,255,255,0.12)"
                strokeWidth="2.5"
              />
              <circle
                cx={(avatarSize + 12) / 2}
                cy={(avatarSize + 12) / 2}
                r={ringRadius}
                fill="none"
                stroke="#30D158"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - Math.max(0.02, Math.min(1, activeProgress)))}
              />
            </svg>
          )}

          <DeviceGlyph kind={peer.deviceKind} />

          {/* Live connection status dot (paired with text badge below — never color alone) */}
          <span
            aria-hidden="true"
            className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#050508] ${
              peer.connectionState === 'connected'
                ? 'bg-lime-signal'
                : peer.connectionState === 'connecting'
                  ? 'bg-amber-system'
                  : 'bg-cyan-warp'
            }`}
          />
        </div>

        <div className="max-w-[124px]">
          <div className="truncate text-xs font-medium tracking-tight text-ink-primary">
            {peer.name}
          </div>
          <div className="mt-0.5 flex items-center justify-center gap-1">
            <span
              className={`inline-flex items-center rounded-full border px-1.5 py-0.2 text-[10px] font-medium leading-4 ${routeBadge.tone}`}
            >
              {routeBadge.short}
            </span>
            {peer.rttMs !== null && (
              <span className="tabular-nums text-[10px] text-ink-tertiary">
                {Math.round(peer.rttMs)}ms
              </span>
            )}
          </div>
        </div>
        </button>
      </motion.div>
    </div>
  );
};
