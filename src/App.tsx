import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { EngineerHUD } from './components/EngineerHUD';
import { GlassCard } from './components/GlassCard';
import { PairingSheet } from './components/PairingSheet';
import { Radar } from './components/Radar';
import { TransferQueue } from './components/TransferQueue';
import { loadCustomTurnServers, saveCustomTurnServers } from './engine/iceCascade';
import { CHANNEL_COUNT, DEFAULT_CHUNK } from './engine/protocol';
import {
  detectDeviceKind,
  detectExtensionSidePanel,
  extractWarpCodeFromHash,
  formatWarpCode,
  loadOrCreateDeviceName,
  SignalingCoordinator,
  type PeerPresence,
} from './engine/signaling';
import {
  WarpWebRTCEngine,
  type TelemetryHUDState,
  type TransferRecord,
} from './engine/webrtc';

const INITIAL_HUD: TelemetryHUDState = {
  activeLinkPeerId: null,
  peerName: null,
  connectionState: 'idle',
  route: 'unknown',
  protocol: null,
  rttMs: null,
  throughputMBps: 0,
  compressionRatio: null,
  compressed: false,
  chunkSize: DEFAULT_CHUNK,
  maxSctpMessageSize: null,
  activeChannels: CHANNEL_COUNT,
  channelBufferedBytes: [0, 0, 0, 0],
  workerMode: 'zero-copy-bridge',
  lz4Ready: false,
  opfsReady: false,
  degraded: false,
};

type CompactSection = 'radar' | 'pair' | 'transfers' | 'settings';

export const App: React.FC = () => {
  const isExtensionSidePanel = detectExtensionSidePanel();
  const isMicGrantTab =
    typeof window !== 'undefined' &&
    window.location.protocol === 'chrome-extension:' &&
    window.location.hash.includes('grant=microphone');

  const [isNarrowViewport, setIsNarrowViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < 720 : false,
  );
  const compact = isExtensionSidePanel || isNarrowViewport;

  const [deviceName, setDeviceName] = useState<string>(() => loadOrCreateDeviceName());
  const [nameDraft, setNameDraft] = useState<string>(deviceName);
  const [turnUrlDraft, setTurnUrlDraft] = useState<string>(() => {
    const saved = loadCustomTurnServers()[0]?.urls;
    return Array.isArray(saved) ? saved[0] ?? '' : saved ?? '';
  });
  const [turnUserDraft, setTurnUserDraft] = useState<string>(() => loadCustomTurnServers()[0]?.username ?? '');
  const [turnCredDraft, setTurnCredDraft] = useState<string>(() =>
    typeof loadCustomTurnServers()[0]?.credential === 'string' ? (loadCustomTurnServers()[0]?.credential as string) : '',
  );
  const [settingsSavedMsg, setSettingsSavedMsg] = useState<string | null>(null);

  const [peers, setPeers] = useState<PeerPresence[]>([]);
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [hud, setHud] = useState<TelemetryHUDState>(INITIAL_HUD);
  const [subnetRoomId, setSubnetRoomId] = useState<string | null>(null);
  const [activeWarpCode, setActiveWarpCode] = useState<string | null>(null);

  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [showPairingDesktop, setShowPairingDesktop] = useState<boolean>(false);
  const [showSettingsDesktop, setShowSettingsDesktop] = useState<boolean>(false);
  const [compactTab, setCompactTab] = useState<CompactSection>('radar');
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>('');
  const [roomBanner, setRoomBanner] = useState<{
    peerId: string;
    peerName: string;
    warpCode: string;
  } | null>(null);
  const [micGrantStatus, setMicGrantStatus] = useState<'idle' | 'granted' | 'denied'>('idle');

  const nameInputId = useId();
  const turnInputId = useId();
  const turnUserId = useId();
  const turnPassId = useId();

  const signalingRef = useRef<SignalingCoordinator | null>(null);
  const engineRef = useRef<WarpWebRTCEngine | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileResolverRef = useRef<((files: File[]) => void) | null>(null);
  const knownOfferIdsRef = useRef<Set<string>>(new Set());

  // Responsive viewport listener
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 719px)');
    const onChange = () => setIsNarrowViewport(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Boot SignalingCoordinator + WarpWebRTCEngine
  useEffect(() => {
    if (isMicGrantTab) return;

    const initialName = loadOrCreateDeviceName();
    let engine: WarpWebRTCEngine | null = null;

    const signaling = new SignalingCoordinator(initialName, {
      onPeersChange: (list) => setPeers(list),
      onPeerDiscovered: (peer) => {
        setLiveAnnouncement(`Device discovered: ${peer.name}`);
        engine?.warmPeer(peer.id, peer.name);
      },
      onPeerRemoved: (peerId) => {
        engine?.handlePeerLeft(peerId);
        setSelectedPeerId((prev) => (prev === peerId ? null : prev));
        setRoomBanner((prev) => (prev?.peerId === peerId ? null : prev));
      },
      onRtcSignal: (peerId, peerName, payload) => {
        void engine?.handleSignal(peerId, peerName, payload);
      },
      onSubnetReady: (roomId) => setSubnetRoomId(roomId),
      onRoomPeerJoined: (peer, warpCode) => {
        setLiveAnnouncement(`${peer.name} joined Warp Room ${formatWarpCode(warpCode)}`);
        setRoomBanner({ peerId: peer.id, peerName: peer.name, warpCode });
      },
      onWarpRoomState: (code) => {
        setActiveWarpCode(code);
        if (!code) setRoomBanner(null);
        if ( typeof window !== 'undefined') {
          if (code) {
            const formatted = formatWarpCode(code);
            if (!window.location.hash.includes(formatted)) {
              window.history.replaceState(null, '', `#warp=${formatted}`);
            }
          } else if (window.location.hash.startsWith('#warp=')) {
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
          }
        }
      },
    });

    engine = new WarpWebRTCEngine(signaling.selfPeerId, initialName, detectDeviceKind(), {
      sendSignal: (peerId, payload) => signaling.sendRtcSignal(peerId, payload),
      onTransfersChange: (nextTransfers) => {
        setTransfers(nextTransfers);
        // Auto-surface incoming offer to user & screen reader once
        for (const tr of nextTransfers) {
          if (tr.status === 'offered' && tr.direction === 'receive' && !knownOfferIdsRef.current.has(tr.id)) {
            knownOfferIdsRef.current.add(tr.id);
            setLiveAnnouncement(`Incoming file offer: ${tr.fileName} from ${tr.peerName}`);
            setCompactTab('transfers');
          }
        }
      },
      onTelemetryChange: (nextHud) => setHud(nextHud),
      onPeerLinkState: (peerId, state, route, rttMs) => {
        signaling.updatePeerLinkTelemetry(peerId, state, route, rttMs);
      },
      onRemoteHello: (peerId, name, kind) => {
        signaling.updatePeerIdentity(peerId, name, kind);
        setRoomBanner((prev) => (prev && prev.peerId === peerId ? { ...prev, peerName: name } : prev));
      },
    });

    signalingRef.current = signaling;
    engineRef.current = engine;

    void signaling.start().then(() => {
      const hashCode = extractWarpCodeFromHash();
      if (hashCode) {
        void signaling.joinWarpCode(hashCode, 'warp');
      }
    });

    const onHashChange = () => {
      const code = extractWarpCodeFromHash();
      if (code) void signaling.joinWarpCode(code, 'warp');
    };
    window.addEventListener('hashchange', onHashChange);

    return () => {
      window.removeEventListener('hashchange', onHashChange);
      engine?.dispose();
      void signaling.dispose();
    };
  }, [isMicGrantTab]);

  // OS File Picker (`window.showOpenFilePicker` with `<input type="file">` fallback)
  const pickFiles = useCallback(async (): Promise<File[]> => {
    const win = window as Window & {
      showOpenFilePicker?: (opts?: { multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
    };
    if (typeof win.showOpenFilePicker === 'function') {
      try {
        const handles = await win.showOpenFilePicker({ multiple: true });
        return await Promise.all(handles.map((h) => h.getFile()));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return [];
      }
    }

    return new Promise<File[]>((resolve) => {
      fileResolverRef.current = resolve;
      const input = fileInputRef.current;
      if (!input) {
        resolve([]);
        return;
      }
      input.value = '';
      input.click();
    });
  }, []);

  const handleFallbackInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    const resolve = fileResolverRef.current;
    fileResolverRef.current = null;
    resolve?.(files);
  };

  const handleSendFilesToPeer = useCallback((peer: PeerPresence, files: File[]) => {
    const engine = engineRef.current;
    if (!engine || files.length === 0) return;
    setSelectedPeerId(peer.id);
    engine.setFocusedPeer(peer.id);
    setStagedFiles([]);
    for (const file of files) {
      void engine.sendFileOffer(peer.id, peer.name, file).catch(() => {});
    }
    if (compact) setCompactTab('transfers');
  }, [compact]);

  const handleJoinWarpCode = useCallback(async (code: string, via: 'warp' | 'sonic'): Promise<string> => {
    if (!signalingRef.current) throw new Error('Signaling engine is still starting');
    return signalingRef.current.joinWarpCode(code, via);
  }, []);

  const handleLeaveWarpCode = useCallback(async () => {
    await signalingRef.current?.leaveWarpCode();
  }, []);

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanedName = nameDraft.trim().slice(0, 32) || deviceName;
    setDeviceName(cleanedName);
    signalingRef.current?.setSelfName(cleanedName);
    engineRef.current?.setSelfName(cleanedName);

    const trimmedTurn = turnUrlDraft.trim();
    if (trimmedTurn) {
      saveCustomTurnServers([
        {
          urls: trimmedTurn,
          ...(turnUserDraft.trim() ? { username: turnUserDraft.trim() } : {}),
          ...(turnCredDraft ? { credential: turnCredDraft } : {}),
        },
      ]);
    } else {
      saveCustomTurnServers([]);
    }

    setSettingsSavedMsg('Preferences saved');
    setTimeout(() => setSettingsSavedMsg(null), 2000);
  };

  // Dedicated Extension Microphone Permission Helper View (#grant=microphone)
  if (isMicGrantTab) {
    const requestMic = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const t of stream.getTracks()) t.stop();
        setMicGrantStatus('granted');
      } catch {
        setMicGrantStatus('denied');
      }
    };
    return (
      <main className="warp-canvas-bg flex min-h-screen items-center justify-center p-6">
        <GlassCard className="max-w-md space-y-4">
          <h1 className="text-lg font-semibold text-white">Enable Microphone for Sonic Drop</h1>
          <p className="text-xs leading-relaxed text-ink-secondary">
            Chromium side panels cannot display the initial microphone permission prompt directly. Granting access once
            here enables 18.5–19.5 kHz ultrasonic pairing inside the AirDrop LAN Warp sidebar.
          </p>
          {micGrantStatus === 'granted' ? (
            <div className="rounded-xl border border-lime-signal/40 bg-lime-signal/15 p-3 text-xs text-lime-signal">
              Microphone access granted. You can close this tab and use Sonic Drop in the sidebar.
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void requestMic()}
              className="warp-btn warp-btn-primary w-full rounded-xl bg-cyan-warp py-2.5 text-xs font-semibold text-white"
            >
              Allow Microphone Access
            </button>
          )}
          {micGrantStatus === 'denied' && (
            <p className="text-xs text-amber-system">
              Permission was blocked. You can still pair across networks anytime using a 6-character Warp Code.
            </p>
          )}
        </GlassCard>
      </main>
    );
  }

  const pendingIncomingCount = transfers.filter((t) => t.status === 'offered' && t.direction === 'receive').length;
  const activeCount = transfers.filter((t) => t.status === 'transferring' || t.status === 'flushing').length;

  return (
    <div className="warp-canvas-bg flex h-full min-h-screen flex-col overflow-x-hidden">
      {/* Hidden Fallback File Input for browsers without window.showOpenFilePicker */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFallbackInputChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* Polite Screen-Reader Live Region */}
      <div className="sr-only" role="status" aria-live="polite">
        {liveAnnouncement}
      </div>

      {/* Top Spatial Functional Header */}
      <header className="z-30 mx-auto flex w-full max-w-[1360px] items-center justify-between gap-3 px-4 pt-3.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <img
            src="./icons/icon-48.png"
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 shrink-0 rounded-lg"
          />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight text-white sm:text-base">
              AirDrop LAN Warp
            </h1>
            {!compact && (
              <p className="truncate text-[11px] text-ink-tertiary">
                Zero-Copy P2P Pointer Engine · {deviceName}
              </p>
            )}
          </div>
        </div>

        {/* Desktop Actions vs Compact Sidebar Segmented Nav */}
        {!compact ? (
          <nav aria-label="Workspace controls" className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                const picked = await pickFiles();
                if (picked.length > 0) setStagedFiles(picked);
              }}
              className="warp-btn warp-btn-primary rounded-full bg-cyan-warp px-4 py-1.5 text-xs font-semibold text-white"
            >
              Send File
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPairingDesktop((v) => !v);
                setShowSettingsDesktop(false);
              }}
              aria-expanded={showPairingDesktop}
              className={`warp-btn warp-btn-subtle rounded-full border px-3.5 py-1.5 text-xs font-medium ${
                showPairingDesktop || activeWarpCode
                  ? 'border-cyan-ice/50 bg-cyan-warp/20 text-cyan-ice'
                  : 'border-white/16 bg-white/[0.05] text-ink-primary'
              }`}
            >
              {activeWarpCode ? `Warp ${formatWarpCode(activeWarpCode)}` : 'Sonic / Warp Code'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowSettingsDesktop((v) => !v);
                setShowPairingDesktop(false);
              }}
              aria-expanded={showSettingsDesktop}
              className={`warp-btn warp-btn-subtle rounded-full border px-3.5 py-1.5 text-xs font-medium ${
                showSettingsDesktop
                  ? 'border-white/35 bg-white/15 text-white'
                  : 'border-white/16 bg-white/[0.05] text-ink-secondary'
              }`}
            >
              Settings
            </button>
          </nav>
        ) : (
          <span className="truncate rounded-full border border-white/12 bg-white/[0.04] px-2.5 py-1 text-[11px] text-ink-secondary">
            {deviceName}
          </span>
        )}
      </header>

      {/* Compact Chrome Sidebar / Mobile Segmented Navigation */}
      {compact && (
        <nav
          aria-label="Primary sections"
          className="mx-4 mt-2.5 grid grid-cols-4 gap-1 rounded-2xl border border-white/12 bg-black/45 p-1"
        >
          {(
            [
              { id: 'radar', label: `Radar (${peers.length})` },
              { id: 'pair', label: activeWarpCode ? 'Paired' : 'Pair' },
              {
                id: 'transfers',
                label:
                  pendingIncomingCount > 0
                    ? `Offers (${pendingIncomingCount})`
                    : activeCount > 0
                      ? `Active (${activeCount})`
                      : 'Transfers',
              },
              { id: 'settings', label: 'Settings' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setCompactTab(item.id)}
              aria-current={compactTab === item.id ? 'page' : undefined}
              className={`warp-btn rounded-xl py-1.5 text-[11px] font-medium ${
                compactTab === item.id
                  ? 'bg-cyan-warp text-white'
                  : item.id === 'transfers' && pendingIncomingCount > 0
                    ? 'bg-lime-signal/20 text-lime-signal'
                    : 'text-ink-secondary hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      )}

      {/* Live Room Join Notification Banner */}
      {activeWarpCode && (
        <div
          role="status"
          aria-live="polite"
          className="z-20 mx-auto mt-2.5 flex w-full max-w-[1360px] px-4 sm:px-6"
        >
          {(() => {
            const joinedPeers = peers.filter(
              (p) => p.warpCode === activeWarpCode || p.discoveryVia === 'warp' || p.discoveryVia === 'sonic',
            );
            const primaryJoined =
              (roomBanner ? joinedPeers.find((p) => p.id === roomBanner.peerId) : null) ?? joinedPeers[0] ?? null;

            if (primaryJoined) {
              return (
                <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-2xl border border-lime-signal/40 bg-lime-signal/[0.11] px-3.5 py-2 text-xs backdrop-blur-md">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-lime-signal" aria-hidden="true" />
                    <span className="truncate font-semibold text-white">
                      {joinedPeers.length === 1
                        ? `${primaryJoined.name} joined Room #${formatWarpCode(activeWarpCode)}`
                        : `${joinedPeers.map((p) => p.name).join(', ')} joined Room #${formatWarpCode(activeWarpCode)}`}
                    </span>
                    <span className="hidden font-mono text-[11px] text-lime-signal sm:inline">
                      · Ready to share
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        if (stagedFiles.length > 0) {
                          handleSendFilesToPeer(primaryJoined, stagedFiles);
                          return;
                        }
                        const picked = await pickFiles();
                        if (picked.length > 0) handleSendFilesToPeer(primaryJoined, picked);
                      }}
                      className="warp-btn warp-btn-primary rounded-full bg-cyan-warp px-3 py-1 text-[11px] font-semibold text-white"
                    >
                      Send File to {primaryJoined.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleLeaveWarpCode()}
                      className="warp-btn rounded-full border border-white/15 bg-white/[0.06] px-2.5 py-1 text-[11px] text-ink-secondary hover:text-white"
                    >
                      Leave
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-2xl border border-cyan-ice/30 bg-cyan-warp/[0.1] px-3.5 py-2 text-xs backdrop-blur-md">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-cyan-ice animate-pulse" aria-hidden="true" />
                  <span className="truncate font-medium text-ink-primary">
                    Room <span className="font-mono font-semibold text-white">#{formatWarpCode(activeWarpCode)}</span> active · Waiting for peer to join…
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (compact) setCompactTab('pair');
                      else setShowPairingDesktop(true);
                    }}
                    className="warp-btn rounded-full border border-cyan-ice/40 bg-cyan-warp/20 px-2.5 py-1 text-[11px] font-medium text-cyan-ice"
                  >
                    Room Code & QR
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleLeaveWarpCode()}
                    className="warp-btn rounded-full border border-white/15 bg-white/[0.06] px-2.5 py-1 text-[11px] text-ink-secondary hover:text-white"
                  >
                    Leave
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Main Content Stage */}
      <main className="mx-auto flex w-full max-w-[1360px] flex-1 flex-col gap-4 px-4 py-3.5 sm:px-6 lg:flex-row">
        {/* Primary Spatial Radar Column */}
        {(!compact || compactTab === 'radar') && (
          <div className="flex min-w-0 flex-1 flex-col">
            <Radar
              selfName={deviceName}
              subnetRoomId={subnetRoomId}
              activeWarpCode={activeWarpCode}
              peers={peers}
              transfers={transfers}
              stagedFiles={stagedFiles}
              selectedPeerId={selectedPeerId}
              compact={compact}
              onStageFiles={(files) => setStagedFiles(files)}
              onClearStagedFiles={() => setStagedFiles([])}
              onPickFiles={pickFiles}
              onSendFilesToPeer={handleSendFilesToPeer}
              onSelectPeer={(id) => {
                setSelectedPeerId(id);
                engineRef.current?.setFocusedPeer(id);
              }}
              onOpenPairing={() => {
                if (compact) setCompactTab('pair');
                else setShowPairingDesktop(true);
              }}
            />
          </div>
        )}

        {/* Side Column (Desktop) OR Active Tab Panel (Compact Sidebar / Mobile) */}
        {(!compact && (showPairingDesktop || showSettingsDesktop || transfers.length > 0)) ||
        (compact && compactTab !== 'radar') ? (
          <div className={`flex flex-col gap-3.5 ${compact ? 'w-full flex-1' : 'w-full lg:w-[400px] lg:shrink-0'}`}>
            {((!compact && showPairingDesktop) || (compact && compactTab === 'pair')) && (
              <PairingSheet
                activeWarpCode={activeWarpCode}
                peers={peers}
                isExtensionSidePanel={isExtensionSidePanel}
                compact={compact}
                onJoinWarpCode={handleJoinWarpCode}
                onLeaveWarpCode={handleLeaveWarpCode}
                onSendToPeer={async (peer) => {
                  if (stagedFiles.length > 0) {
                    handleSendFilesToPeer(peer, stagedFiles);
                    return;
                  }
                  const picked = await pickFiles();
                  if (picked.length > 0) handleSendFilesToPeer(peer, picked);
                }}
                onClose={!compact ? () => setShowPairingDesktop(false) : undefined}
              />
            )}

            {((!compact && showSettingsDesktop) || (compact && compactTab === 'settings')) && (
              <GlassCard as="section" aria-label="Device and network settings" padding={compact ? 'sm' : 'md'}>
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-ink-primary">Device & TURN Settings</h2>
                  {!compact && (
                    <button
                      type="button"
                      onClick={() => setShowSettingsDesktop(false)}
                      className="warp-btn warp-btn-subtle rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-1 text-xs text-ink-secondary"
                    >
                      Done
                    </button>
                  )}
                </div>

                <form onSubmit={handleSaveSettings} className="mt-3 space-y-3">
                  <div>
                    <label htmlFor={nameInputId} className="block text-xs font-medium text-ink-secondary">
                      Visible Device Name
                    </label>
                    <input
                      id={nameInputId}
                      type="text"
                      maxLength={32}
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-white/18 bg-black/50 px-3 py-2 text-xs text-white"
                    />
                  </div>

                  <div className="calm-row space-y-2 rounded-2xl p-3">
                    <div className="text-xs font-medium text-ink-primary">
                      Custom Tier-3 TURN Server (Optional)
                    </div>
                    <p className="text-[11px] text-ink-tertiary">
                      Overrides default community TURN relays for symmetric CGNAT traversal. Payload remains end-to-end
                      DTLS-encrypted.
                    </p>
                    <div>
                      <label htmlFor={turnInputId} className="block text-[11px] text-ink-secondary">
                        TURN URI (`turn:` or `turns:`)
                      </label>
                      <input
                        id={turnInputId}
                        type="text"
                        placeholder="turns:turn.example.org:443?transport=tcp"
                        value={turnUrlDraft}
                        onChange={(e) => setTurnUrlDraft(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-white/15 bg-black/50 px-2.5 py-1.5 font-mono text-xs text-white placeholder:text-white/25"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label htmlFor={turnUserId} className="block text-[11px] text-ink-secondary">
                          Username
                        </label>
                        <input
                          id={turnUserId}
                          type="text"
                          value={turnUserDraft}
                          onChange={(e) => setTurnUserDraft(e.target.value)}
                          className="mt-1 w-full rounded-xl border border-white/15 bg-black/50 px-2.5 py-1.5 font-mono text-xs text-white"
                        />
                      </div>
                      <div>
                        <label htmlFor={turnPassId} className="block text-[11px] text-ink-secondary">
                          Credential
                        </label>
                        <input
                          id={turnPassId}
                          type="password"
                          value={turnCredDraft}
                          onChange={(e) => setTurnCredDraft(e.target.value)}
                          className="mt-1 w-full rounded-xl border border-white/15 bg-black/50 px-2.5 py-1.5 font-mono text-xs text-white"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="submit"
                      className="warp-btn warp-btn-primary rounded-xl bg-cyan-warp px-4 py-2 text-xs font-semibold text-white"
                    >
                      Save Preferences
                    </button>
                    {settingsSavedMsg && (
                      <span role="status" className="text-xs font-medium text-lime-signal">
                        {settingsSavedMsg}
                      </span>
                    )}
                  </div>
                </form>
              </GlassCard>
            )}

            {((!compact && transfers.length > 0) || (compact && compactTab === 'transfers')) && (
              <>
                {transfers.length > 0 ? (
                  <TransferQueue
                    transfers={transfers}
                    compact={compact}
                    onAccept={(id) => void engineRef.current?.acceptOffer(id)}
                    onDecline={(id) => engineRef.current?.declineOffer(id)}
                    onPause={(id) => engineRef.current?.pauseTransfer(id)}
                    onResume={(id) => engineRef.current?.resumeTransfer(id)}
                    onCancel={(id) => engineRef.current?.cancelTransfer(id)}
                    onClearFinished={() => engineRef.current?.clearFinishedTransfers()}
                  />
                ) : (
                  <GlassCard padding="md" className="text-center">
                    <p className="text-xs font-medium text-ink-primary">No transfers yet</p>
                    <p className="mt-1 text-[11px] text-ink-secondary">
                      Select a peer on the Radar to send a zero-copy file pointer, or wait for an incoming offer.
                    </p>
                  </GlassCard>
                )}
              </>
            )}
          </div>
        ) : null}
      </main>

      {/* Bottom Dynamic Island Engineer HUD */}
      <footer className="mx-auto w-full max-w-[1360px] px-4 pb-3.5 sm:px-6">
        <EngineerHUD hud={hud} compact={compact} />
      </footer>
    </div>
  );
};

export default App;
