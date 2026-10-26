import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { formatBytes } from '../engine/protocol';
import type { PeerPresence } from '../engine/signaling';
import type { TransferRecord } from '../engine/webrtc';
import { PeerNode } from './PeerNode';
import { TetherLine, type ActiveTetherStream, type Point2D } from './TetherLine';

export interface RadarProps {
  selfName: string;
  subnetRoomId: string | null;
  activeWarpCode: string | null;
  peers: PeerPresence[];
  transfers: TransferRecord[];
  stagedFiles: File[];
  selectedPeerId: string | null;
  compact: boolean;
  onStageFiles: (files: File[]) => void;
  onClearStagedFiles: () => void;
  onPickFiles: () => Promise<File[]>;
  onSendFilesToPeer: (peer: PeerPresence, files: File[]) => void;
  onSelectPeer: (peerId: string) => void;
  onOpenPairing: () => void;
}

interface PositionedPeer {
  peer: PeerPresence;
  x: number;
  y: number;
}

const SNAP_RADIUS_PX = 58;
const DRAG_HYSTERESIS_PX = 8;

export const Radar: React.FC<RadarProps> = ({
  selfName,
  subnetRoomId,
  activeWarpCode,
  peers,
  transfers,
  stagedFiles,
  selectedPeerId,
  compact,
  onStageFiles,
  onClearStagedFiles,
  onPickFiles,
  onSendFilesToPeer,
  onSelectPeer,
  onOpenPairing,
}) => {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const activePointerId = useRef<number | null>(null);
  const pointerOrigin = useRef<Point2D | null>(null);

  const [bounds, setBounds] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number; snappedPeerId: string | null } | null>(null);
  const [stageDragOver, setStageDragOver] = useState(false);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setBounds({ width: rect.width, height: rect.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const center = useMemo<Point2D>(() => {
    const w = bounds.width || 360;
    const h = bounds.height || 360;
    return {
      x: w * 0.5,
      y: peers.length === 0 ? h * 0.46 : h * 0.52,
    };
  }, [bounds.height, bounds.width, peers.length]);

  const positionedPeers = useMemo<PositionedPeer[]>(() => {
    if (peers.length === 0 || bounds.width === 0 || bounds.height === 0) return [];
    const padX = compact ? 54 : 74;
    const padY = compact ? 58 : 74;
    const rx = Math.max(76, Math.min(bounds.width * 0.5 - padX, 230));
    const ry = Math.max(76, Math.min(bounds.height * 0.5 - padY, 195));

    // Place single/few peers in an upper arc first (natural AirDrop fan), full ring when >= 4 peers.
    return peers.map((peer, idx) => {
      let angleRad: number;
      if (peers.length === 1) {
        angleRad = -Math.PI / 2;
      } else if (peers.length === 2) {
        angleRad = idx === 0 ? (-3 * Math.PI) / 4 : -Math.PI / 4;
      } else if (peers.length === 3) {
        const angles = [(-5 * Math.PI) / 6, -Math.PI / 2, -Math.PI / 6];
        angleRad = angles[idx];
      } else {
        angleRad = -Math.PI / 2 + (idx * 2 * Math.PI) / peers.length;
      }
      return {
        peer,
        x: center.x + Math.cos(angleRad) * rx,
        y: center.y + Math.sin(angleRad) * ry,
      };
    });
  }, [bounds.height, bounds.width, center.x, center.y, compact, peers]);

  const findNearestPeer = useCallback(
    (pt: Point2D): PositionedPeer | null => {
      let best: PositionedPeer | null = null;
      let bestDist = SNAP_RADIUS_PX;
      for (const item of positionedPeers) {
        const d = Math.hypot(item.x - pt.x, item.y - pt.y);
        if (d <= bestDist) {
          bestDist = d;
          best = item;
        }
      }
      return best;
    },
    [positionedPeers],
  );

  // Active 4-channel particle streams for transferring/flushing records
  const activeStreams = useMemo<ActiveTetherStream[]>(() => {
    const out: ActiveTetherStream[] = [];
    for (const tr of transfers) {
      if (tr.status !== 'transferring' && tr.status !== 'flushing') continue;
      const target = positionedPeers.find((p) => p.peer.id === tr.peerId);
      if (!target) continue;
      out.push({
        id: tr.id,
        target: { x: target.x, y: target.y },
        direction: tr.direction,
        channels: tr.activeChannels,
        degraded: (tr.rttMs ?? 0) > 120,
      });
    }
    return out;
  }, [positionedPeers, transfers]);

  const progressByPeer = useMemo(() => {
    const map = new Map<string, number>();
    for (const tr of transfers) {
      if (tr.status === 'transferring' || tr.status === 'flushing') {
        const ratio = tr.fileSize > 0 ? tr.bytesTransferred / tr.fileSize : 1;
        map.set(tr.peerId, ratio);
      }
    }
    return map;
  }, [transfers]);

  // 1:1 Pointer-capture elastic tether dragging from the Host Node
  const handleHostPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (activePointerId.current !== null) return; // multi-touch protection
    if (peers.length === 0 || stagedFiles.length === 0) return;
    activePointerId.current = e.pointerId;
    pointerOrigin.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleHostPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (activePointerId.current !== e.pointerId || !stageRef.current || !pointerOrigin.current) return;
    const moved = Math.hypot(e.clientX - pointerOrigin.current.x, e.clientY - pointerOrigin.current.y);
    if (moved < DRAG_HYSTERESIS_PX && !dragPoint) return;

    const rect = stageRef.current.getBoundingClientRect();
    const localPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const snap = findNearestPeer(localPt);
    if (snap) {
      setDragPoint({ x: snap.x, y: snap.y, snappedPeerId: snap.peer.id });
    } else {
      setDragPoint({ x: localPt.x, y: localPt.y, snappedPeerId: null });
    }
  };

  const finishHostPointer = (e: React.PointerEvent<HTMLButtonElement>, commit: boolean) => {
    if (activePointerId.current !== e.pointerId) return;
    activePointerId.current = null;
    pointerOrigin.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (commit && dragPoint?.snappedPeerId && stagedFiles.length > 0) {
      const target = peers.find((p) => p.id === dragPoint.snappedPeerId);
      if (target) onSendFilesToPeer(target, stagedFiles);
    }
    setDragPoint(null);
  };

  const handleHostClick = async () => {
    // Only trigger picker when not completing a drag gesture.
    if (dragPoint) return;
    const picked = await onPickFiles();
    if (picked.length > 0) {
      if (selectedPeerId) {
        const target = peers.find((p) => p.id === selectedPeerId);
        if (target) {
          onSendFilesToPeer(target, picked);
          return;
        }
      }
      onStageFiles(picked);
    }
  };

  const handlePeerSelectAndAct = async (peer: PeerPresence) => {
    onSelectPeer(peer.id);
    if (stagedFiles.length > 0) {
      onSendFilesToPeer(peer, stagedFiles);
      return;
    }
    const picked = await onPickFiles();
    if (picked.length > 0) {
      onSendFilesToPeer(peer, picked);
    }
  };

  const handleStageDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setStageDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (peers.length === 1) {
      onSendFilesToPeer(peers[0], files);
    } else {
      onStageFiles(files);
    }
  };

  const ringDiameter = Math.max(220, Math.min(bounds.width || 340, bounds.height || 340) * 0.9);
  const totalStagedBytes = stagedFiles.reduce((acc, f) => acc + f.size, 0);
  const roomPeersCount = activeWarpCode
    ? peers.filter((p) => p.warpCode === activeWarpCode || p.discoveryVia === 'warp' || p.discoveryVia === 'sonic').length
    : 0;

  return (
    <section
      aria-label="Nearby devices radar"
      ref={stageRef}
      onDragOver={(e) => {
        e.preventDefault();
        if (!stageDragOver) setStageDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setStageDragOver(false);
      }}
      onDrop={handleStageDrop}
      className={`relative flex w-full flex-1 select-none flex-col items-center justify-center overflow-hidden rounded-glass border transition-colors duration-150 ${
        compact ? 'min-h-[300px]' : 'min-h-[420px]'
      } ${
        stageDragOver
          ? 'border-cyan-ice bg-cyan-warp/[0.08]'
          : 'border-white/[0.09] bg-white/[0.015]'
      }`}
    >
      {/* Top Status Strip inside Radar */}
      <div className="pointer-events-none absolute inset-x-4 top-3.5 z-20 flex items-center justify-between gap-2 text-xs">
        <div className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-white/12 bg-black/45 px-3 py-1 backdrop-blur-md">
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${peers.length > 0 ? 'bg-lime-signal' : 'bg-cyan-warp animate-pulse'}`}
          />
          <span className="font-medium text-ink-primary" aria-live="polite">
            {peers.length === 0
              ? activeWarpCode
                ? `Room #${activeWarpCode.slice(0, 3)}-${activeWarpCode.slice(3)} · Waiting for peer…`
                : 'Scanning local network…'
              : activeWarpCode && roomPeersCount > 0
                ? `${peers.length} ${peers.length === 1 ? 'device' : 'devices'} in range · ${roomPeersCount} in Room`
                : `${peers.length} ${peers.length === 1 ? 'device' : 'devices'} in range`}
          </span>
        </div>

        {activeWarpCode ? (
          <button
            type="button"
            onClick={onOpenPairing}
            className={`warp-btn warp-btn-subtle pointer-events-auto inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[11px] font-medium ${
              roomPeersCount > 0
                ? 'border-lime-signal/45 bg-lime-signal/15 text-lime-signal'
                : 'border-cyan-ice/35 bg-cyan-warp/15 text-cyan-ice'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${roomPeersCount > 0 ? 'bg-lime-signal' : 'bg-cyan-ice'}`}
            />
            <span>
              Warp #{activeWarpCode.slice(0, 3)}-{activeWarpCode.slice(3)}
              {roomPeersCount > 0 ? ` (${roomPeersCount} joined)` : ''}
            </span>
          </button>
        ) : (
          subnetRoomId && !compact && (
            <span className="hidden rounded-full border border-white/10 bg-black/35 px-2.5 py-1 font-mono text-[11px] text-ink-tertiary sm:inline-block">
              Subnet {subnetRoomId.replace('lan-', '').toUpperCase()}
            </span>
          )
        )}
      </div>

      {/* Static Subtle Range Guides + GPU-Animated Concentric Scanning Waves */}
      <div
        style={{ left: `${center.x}px`, top: `${center.y}px` }}
        className="pointer-events-none absolute z-0"
        aria-hidden="true"
      >
        <div
          style={{ width: ringDiameter * 0.44, height: ringDiameter * 0.44 }}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/[0.05]"
        />
        <div
          style={{ width: ringDiameter * 0.72, height: ringDiameter * 0.72 }}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/[0.045]"
        />
        <div
          style={{ width: ringDiameter, height: ringDiameter }}
          className="radar-wave"
        />
        <div
          style={{ width: ringDiameter, height: ringDiameter }}
          className="radar-wave radar-wave-delay-1"
        />
        <div
          style={{ width: ringDiameter, height: ringDiameter }}
          className="radar-wave radar-wave-delay-2"
        />
      </div>

      {/* Bezier Tether & 4-Stream Particle Overlay */}
      <TetherLine
        width={bounds.width}
        height={bounds.height}
        origin={center}
        dragTarget={
          dragPoint
            ? { x: dragPoint.x, y: dragPoint.y, snapped: dragPoint.snappedPeerId !== null }
            : null
        }
        activeStreams={activeStreams}
      />

      {/* Discovered Peer Nodes */}
      <AnimatePresence>
        {positionedPeers.map(({ peer, x, y }) => (
          <PeerNode
            key={peer.id}
            peer={peer}
            x={x}
            y={y}
            compact={compact}
            isSelected={selectedPeerId === peer.id}
            isSnappedTarget={dragPoint?.snappedPeerId === peer.id}
            hasStagedFiles={stagedFiles.length > 0}
            activeProgress={progressByPeer.get(peer.id) ?? null}
            onSelectAndAct={handlePeerSelectAndAct}
            onDropFiles={onSendFilesToPeer}
          />
        ))}
      </AnimatePresence>

      {/* Central Host Avatar + Staged File Pointer Origin */}
      <div
        style={{ left: `${center.x}px`, top: `${center.y}px` }}
        className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
      >
        <button
          type="button"
          onPointerDown={handleHostPointerDown}
          onPointerMove={handleHostPointerMove}
          onPointerUp={(e) => finishHostPointer(e, true)}
          onPointerCancel={(e) => finishHostPointer(e, false)}
          onClick={() => void handleHostClick()}
          aria-label={
            stagedFiles.length > 0 && peers.length > 0
              ? `File pointer staged (${stagedFiles.length} file). Drag tether to a peer or click to choose different file.`
              : 'Choose file to share as zero-copy pointer'
          }
          className={`warp-btn group relative flex items-center justify-center rounded-full border ${
            compact ? 'h-16 w-16' : 'h-20 w-20'
          } ${
            stagedFiles.length > 0
              ? 'border-lime-signal bg-lime-signal/20 text-white shadow-[0_0_36px_rgba(48,209,88,0.42)] cursor-grab active:cursor-grabbing'
              : 'glass-pill border-cyan-warp/55 text-white shadow-[0_0_32px_rgba(10,132,255,0.28)]'
          }`}
        >
          {stagedFiles.length > 0 ? (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#30D158" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <path d="M12 18v-6" />
              <path d="m9 15 3-3 3 3" />
            </svg>
          ) : (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#64D2FF" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h.01" />
              <path d="M8.5 16.429a5 5 0 0 1 7 0" />
              <path d="M5 12.859a10 10 0 0 1 14 0" />
              <path d="M2 8.82a15 15 0 0 1 20 0" />
            </svg>
          )}
        </button>

        <div className="mt-2 text-center">
          <div className="text-xs font-semibold tracking-tight text-ink-primary">{selfName} (You)</div>
          <div className="text-[11px] text-ink-secondary">
            {stagedFiles.length > 0
              ? peers.length > 0
                ? 'Drag tether to a peer or tap peer'
                : 'Pointer staged · waiting for peer'
              : 'Drop file or tap to stage pointer'}
          </div>
        </div>
      </div>

      {/* Bottom Staged Pointer Chip OR Empty-Network Guidance */}
      <div className="pointer-events-none absolute inset-x-4 bottom-3.5 z-20 flex flex-col items-center">
        {stagedFiles.length > 0 ? (
          <div className="glass-pill pointer-events-auto flex max-w-full items-center gap-2.5 rounded-full px-3.5 py-1.5 text-xs">
            <span className="h-2 w-2 shrink-0 rounded-full bg-lime-signal" aria-hidden="true" />
            <span className="truncate font-medium text-ink-primary">
              {stagedFiles.length === 1 ? stagedFiles[0].name : `${stagedFiles.length} files staged`}
            </span>
            <span className="tabular-nums shrink-0 text-ink-tertiary">
              {formatBytes(totalStagedBytes)}
            </span>
            <button
              type="button"
              onClick={onClearStagedFiles}
              aria-label="Clear staged file pointer"
              className="warp-btn ml-1 rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-ink-secondary hover:text-white"
            >
              Clear
            </button>
          </div>
        ) : peers.length === 0 ? (
          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 text-center">
            <button
              type="button"
              onClick={() => void handleHostClick()}
              className="warp-btn warp-btn-primary rounded-full bg-cyan-warp px-4 py-2 text-xs font-semibold text-white"
            >
              Choose File
            </button>
            <button
              type="button"
              onClick={onOpenPairing}
              className="warp-btn warp-btn-subtle rounded-full border border-white/18 bg-white/[0.06] px-4 py-2 text-xs font-medium text-ink-primary"
            >
              Pair Across Networks (Sonic / Warp)
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
};
