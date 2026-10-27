import {
  detectDeviceProfile,
  lowWatermarkFor,
  negotiateJointTransferPlan,
  scanSystemHardware,
} from './autotune';
import {
  buildPresetSteps,
  summarizeBenchmarkSuite,
  type BenchmarkPresetId,
  type BenchmarkRunResult,
  type BenchmarkStepSpec,
  type BenchmarkSuiteSummary,
  type BenchmarkUserMetadata,
} from './benchmark';
import { ChannelPool } from './channelPool';
import {
  buildRtcConfig,
  emptyTelemetrySnapshot,
  IceCascadeMonitor,
  sampleLinkTelemetry,
  type CascadeStage,
  type LinkTelemetrySnapshot,
} from './iceCascade';
import { chooseSaveTarget, hasQuotaFor, triggerDownload } from './opfsDiskStream';
import {
  CHANNEL_COUNT,
  DEFAULT_CHUNK,
  INITIAL_HIGH_WATERMARK,
  LANE_CHANNELS,
  LOW_WATERMARK,
  MAX_CHUNK,
  randomId,
  type ActiveTransportKind,
  type ControlMessage,
  type FileOfferMeta,
  type FromWorker,
  type IceRoute,
  type PeerCaps,
  type SinkKind,
  type SystemHardwareProfile,
  type TransportMode,
  type TuneConfig,
  type TunerSnapshot,
  type ToWorker,
  type WorkerChannelMode,
} from './protocol';

export type SignalWirePayload =
  | { gen: number; stage: CascadeStage; kind: 'sdp'; description: RTCSessionDescriptionInit }
  | { gen: number; stage: CascadeStage; kind: 'ice'; candidate: RTCIceCandidateInit }
  | { gen: number; stage: CascadeStage; kind: 'rebuild'; targetStage: CascadeStage };

export type TransferDirection = 'send' | 'receive';

export type TransferStatus =
  | 'analyzing'
  | 'offering'
  | 'offered'
  | 'connecting'
  | 'transferring'
  | 'flushing'
  | 'paused'
  | 'completed'
  | 'declined'
  | 'cancelled'
  | 'failed';

export interface TransferRecord {
  id: string;
  peerId: string;
  peerName: string;
  direction: TransferDirection;
  fileName: string;
  fileSize: number;
  mime: string;
  entropy: number;
  compressed: boolean;
  transport: ActiveTransportKind;
  retransmittedBlocks: number;
  status: TransferStatus;
  bytesTransferred: number;
  wireBytesTransferred: number;
  throughputMBps: number | null;
  wireThroughputMBps: number | null;
  etaSeconds: number | null;
  compressionRatio: number | null;
  chunkSize: number;
  activeChannels: number;
  activeLanes: number;
  route: IceRoute;
  candidatePairLabel: string;
  rttMs: number | null;
  sink: SinkKind | null;
  integrityVerified: boolean | null;
  finalizeMs: number | null;
  savedVia: 'filesystem-handle' | 'opfs-download' | null;
  errorMessage: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface TelemetryHUDState {
  activeLinkPeerId: string | null;
  peerName: string | null;
  connectionState: RTCPeerConnectionState | 'idle';
  route: IceRoute;
  candidatePairLabel: string;
  protocol: string | null;
  rttMs: number | null;
  throughputMBps: number;
  wireThroughputMBps: number;
  statsWireMBps: number;
  compressionRatio: number | null;
  compressed: boolean;
  transportMode: TransportMode;
  activeTransport: ActiveTransportKind;
  selfHw: SystemHardwareProfile | null;
  peerHw: SystemHardwareProfile | null;
  topologyLabel: string;
  concurrentTransfers: number;
  chunkSize: number;
  maxSctpMessageSize: number | null;
  activeChannels: number;
  activeLanes: number;
  connectedLanes: number;
  highWatermark: number;
  lowWatermark: number;
  channelBufferedBytes: number[];
  channelLaneIds: string[];
  workerMode: WorkerChannelMode;
  sink: SinkKind | null;
  receiverPendingBytes: number;
  tuner: TunerSnapshot | null;
  lz4Ready: boolean;
  opfsReady: boolean;
  opfsSyncReady: boolean;
  secureContext: boolean;
  degraded: boolean;
  turboAvailable: boolean;
  localBusAvailable: boolean;
  turboEndpoints: string[];
  peerLanTurboUrl: string | null;
}

interface SpeedSample {
  t: number;
  bytes: number;
  wireBytes: number;
}

interface ExtraLane {
  id: string;
  pc: RTCPeerConnection;
  channels: RTCDataChannel[];
  blastChannels: RTCDataChannel[];
  bridgeOnly: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  openWaiters: Array<() => void>;
  closed: boolean;
}

interface PeerLink {
  linkId: string;
  peerId: string;
  peerName: string;
  gen: number;
  stage: CascadeStage;
  pc: RTCPeerConnection;
  ctrl: RTCDataChannel;
  dataChannels: RTCDataChannel[];
  blastChannels: RTCDataChannel[];
  bridgePool: ChannelPool | null;
  blastBridgePool: ChannelPool | null;
  nativeWorkerChannels: boolean;
  peerCaps: PeerCaps;
  localBusToken: string | null;
  peerLanTurboUrl: string | null;
  seededByBench: boolean;
  extraLanes: Map<string, ExtraLane>;
  cascade: IceCascadeMonitor;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  openWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  telemetry: LinkTelemetrySnapshot;
  statsWireMBps: number;
  lastStatsSample: { t: number; totalBytes: number } | null;
  pingRttMs: number | null;
  pingWaiters: Map<string, (rttMs: number) => void>;
  buffered: number[];
  channelLaneIds: string[];
  activeChannels: number;
  highWatermark: number;
  lowWatermark: number;
  lastTuner: TunerSnapshot | null;
  lastSink: SinkKind | null;
  receiverPendingBytes: number;
  pendingAckBytes: number;
  ackScheduled: boolean;
  pendingBlastAckBytes: number;
  blastAckScheduled: boolean;
  bridgeHandoffs: number;
  bridgeWaitMs: number;
  disposed: boolean;
}

interface ActiveBenchSender {
  id: string;
  link: PeerLink;
  setupStartedAt: number;
  setupMs: number;
  readyResolve: ((info: { window: number; sink: SinkKind }) => void) | null;
  readyReject: ((err: Error) => void) | null;
  drainedData: Extract<FromWorker, { type: 'send-drained' }> | null;
  remoteResult: Extract<ControlMessage, { t: 'bench-result' }> | null;
  doneResolve: (() => void) | null;
  doneReject: ((err: Error) => void) | null;
}

export interface WarpEngineCallbacks {
  sendSignal: (peerId: string, payload: SignalWirePayload) => void;
  onTransfersChange: (transfers: TransferRecord[]) => void;
  onTelemetryChange: (hud: TelemetryHUDState) => void;
  onPeerLinkState?: (peerId: string, state: RTCPeerConnectionState, route: IceRoute, rttMs: number | null) => void;
  onRemoteHello?: (peerId: string, name: string, deviceKind: 'desktop' | 'mobile' | 'extension') => void;
}

const HOST_HEAD_START_MS = 650;
const TRANSPORT_MODE_STORAGE_KEY = 'warp:transport-mode-v1';

function loadStoredTransportMode(): TransportMode {
  try {
    const raw = localStorage.getItem(TRANSPORT_MODE_STORAGE_KEY);
    if (raw === 'auto' || raw === 'lan-turbo' || raw === 'blast-nack' || raw === 'reliable-sctp') return raw;
  } catch {
    // Ignore storage access errors in restricted frames.
  }
  return 'auto';
}

interface TransferTransportMeta {
  turboEndpoint: string | null;
  turboInstanceId: string | null;
  localBusToken: string | null;
}

export class WarpWebRTCEngine {
  private readonly deviceProfile = detectDeviceProfile();
  private selfHw: SystemHardwareProfile | null = null;
  private transportMode: TransportMode = loadStoredTransportMode();
  private readonly selfLocalBusId = randomId(8);
  private busProbeChannel: BroadcastChannel | null = null;
  private readonly reachableTurboByInstance = new Map<string, string>();
  private readonly localTurboInstanceIds = new Set<string>();
  private selfTurboLanUrls: string[] = [];
  private lastTurboSignature = '';
  private readonly initialTurboProbePromise: Promise<void>;
  private turboProbeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly worker: Worker;
  private lz4Ready = false;
  private opfsReady = false;
  private opfsSyncReady = false;
  private secureContext = typeof window !== 'undefined' ? Boolean(window.isSecureContext) : true;
  private workerReadyResolve!: () => void;
  private readonly workerReadyPromise: Promise<void>;

  private readonly links = new Map<string, PeerLink>();
  private readonly linkById = new Map<string, PeerLink>();
  private readonly transfers = new Map<string, TransferRecord>();
  private readonly transferTransportMeta = new Map<string, TransferTransportMeta>();
  private readonly sourceFiles = new Map<string, File>();
  private readonly speedHistory = new Map<string, SpeedSample[]>();
  private readonly sendDrainedHashes = new Map<string, string>();
  private readonly remoteCompletedInfo = new Map<
    string,
    { hash?: string; sink?: SinkKind; writeMs?: number; finalizeMs?: number }
  >();
  private readonly pendingAnalyses = new Map<
    string,
    { resolve: (v: { entropy: number; compress: boolean }) => void; reject: (e: Error) => void }
  >();
  private readonly benchSenders = new Map<string, ActiveBenchSender>();
  private readonly benchRecvLinks = new Map<string, PeerLink>();
  private benchAborted = false;

  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private focusedPeerId: string | null = null;

  constructor(
    private readonly selfId: string,
    private selfName: string,
    private readonly selfDeviceKind: 'desktop' | 'mobile' | 'extension',
    private readonly callbacks: WarpEngineCallbacks,
  ) {
    this.workerReadyPromise = new Promise<void>((res) => {
      this.workerReadyResolve = res;
    });
    this.worker = new Worker(new URL('../worker/transfer.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.handleWorkerMessage);
    this.postWorker({ type: 'init' });

    void scanSystemHardware(false).then((hw) => {
      if (!this.selfHw) {
        this.selfHw = hw;
        this.emitHud();
      }
    });

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const ch = new BroadcastChannel('warp-local-bus-probe-v1');
        ch.onmessage = (ev: MessageEvent<{ targetBusId?: string; senderPeerId?: string; token?: string }>) => {
          const d = ev.data;
          if (!d || d.targetBusId !== this.selfLocalBusId || !d.senderPeerId || !d.token) return;
          const link = this.links.get(d.senderPeerId);
          if (link && !link.disposed) {
            link.localBusToken = d.token;
            this.sendControl(link, { t: 'local-bus-ack', token: d.token });
            this.emitHud();
          }
        };
        this.busProbeChannel = ch;
      } catch {
        this.busProbeChannel = null;
      }
    }

    this.initialTurboProbePromise = this.probeLocalTurboServer();
    this.turboProbeTimer = setInterval(() => {
      if (this.benchSenders.size === 0 && this.benchRecvLinks.size === 0) {
        void this.probeLocalTurboServer();
      }
    }, 5_000);

    this.telemetryTimer = setInterval(() => {
      void this.tickTelemetry();
    }, 450);
  }

  private get selfCaps(): PeerCaps {
    return {
      lanes: this.deviceProfile.maxExtraLanes,
      credit: true,
      bench: true,
      blastNack: true,
      localBusId: this.selfLocalBusId,
      turboEndpoints: this.selfTurboLanUrls.length > 0 ? this.selfTurboLanUrls : undefined,
      turboInstances:
        this.reachableTurboByInstance.size > 0 ? [...this.reachableTurboByInstance.keys()] : undefined,
      userAgentSummary: this.deviceProfile.summary,
      hw: this.selfHw ?? undefined,
    };
  }

  private async probeTurboOrigin(
    origin: string,
    timeoutMs = 650,
  ): Promise<{ instanceId: string; endpoints: string[] } | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${origin.replace(/\/+$/, '')}/warp-turbo/info`, {
        method: 'GET',
        signal: ctrl.signal,
        cache: 'no-store',
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        ok?: boolean;
        service?: string;
        instanceId?: string;
        endpoints?: string[];
      };
      if (!data?.ok || data.service !== 'airdrop-lan-warp-turbo' || typeof data.instanceId !== 'string') {
        return null;
      }
      return {
        instanceId: data.instanceId,
        endpoints: Array.isArray(data.endpoints) ? data.endpoints : [],
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async probeLocalTurboServer(): Promise<void> {
    const candidates: string[] = [];
    if (typeof window !== 'undefined' && window.location.protocol === 'http:' && window.location.origin) {
      candidates.push(window.location.origin);
    }
    if (!candidates.includes('http://127.0.0.1:8787')) {
      candidates.push('http://127.0.0.1:8787');
    }

    const foundLocalIds = new Set<string>();
    const lanUrls = new Set<string>();

    for (const origin of candidates) {
      const info = await this.probeTurboOrigin(origin, 550);
      if (!info) continue;
      foundLocalIds.add(info.instanceId);
      this.reachableTurboByInstance.set(info.instanceId, origin);
      for (const ep of info.endpoints) {
        if (!ep.includes('127.0.0.1') && !ep.includes('localhost')) {
          lanUrls.add(ep);
        }
      }
    }

    for (const oldId of [...this.localTurboInstanceIds]) {
      if (!foundLocalIds.has(oldId)) {
        this.localTurboInstanceIds.delete(oldId);
        this.reachableTurboByInstance.delete(oldId);
      }
    }
    for (const id of foundLocalIds) this.localTurboInstanceIds.add(id);
    this.selfTurboLanUrls = [...lanUrls];

    const sig = `${[...this.reachableTurboByInstance.entries()].map(([k, v]) => `${k}@${v}`).join(',')}|${this.selfTurboLanUrls.join(',')}`;
    if (sig !== this.lastTurboSignature) {
      this.lastTurboSignature = sig;
      this.broadcastHello();
      this.emitHud();
    }
  }

  private async probePeerTurboEndpoints(link: PeerLink): Promise<void> {
    const endpoints = link.peerCaps.turboEndpoints ?? [];
    if (endpoints.length === 0 || link.disposed) return;

    let changed = false;
    for (const ep of endpoints) {
      if (link.disposed) return;
      const info = await this.probeTurboOrigin(ep, 700);
      if (!info) continue;
      if (!this.reachableTurboByInstance.has(info.instanceId)) {
        this.reachableTurboByInstance.set(info.instanceId, ep);
        changed = true;
      }
    }
    if (changed && !link.disposed) {
      this.broadcastHello();
      this.emitHud();
    }
  }

  private resolveSharedTurbo(link: PeerLink | null): { instanceId: string; localUrl: string } | null {
    if (!link) return null;
    const peerInstances = link.peerCaps.turboInstances ?? [];
    for (const instId of peerInstances) {
      const localUrl = this.reachableTurboByInstance.get(instId);
      if (localUrl) return { instanceId: instId, localUrl };
    }
    return null;
  }

  private broadcastHello(): void {
    for (const link of this.links.values()) {
      if (link.ctrl.readyState === 'open') {
        this.sendControl(link, {
          t: 'hello',
          name: this.selfName,
          deviceKind: this.selfDeviceKind,
          caps: this.selfCaps,
        });
      }
    }
  }

  getTransportMode(): TransportMode {
    return this.transportMode;
  }

  setTransportMode(mode: TransportMode): void {
    this.transportMode = mode;
    try {
      localStorage.setItem(TRANSPORT_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage access errors.
    }
    this.emitHud();
  }

  setSelfName(name: string): void {
    this.selfName = name;
    this.broadcastHello();
  }

  setFocusedPeer(peerId: string | null): void {
    this.focusedPeerId = peerId;
    this.emitHud();
  }

  applyRecommendedConfig(peerId: string, config: Partial<TuneConfig>): void {
    const link = this.links.get(peerId);
    if (!link) return;
    link.seededByBench = true;
    this.postWorker({ type: 'seed', linkId: link.linkId, config });
  }

  cancelBenchmarks(): void {
    this.benchAborted = true;
    for (const b of [...this.benchSenders.values()]) {
      this.postWorker({ type: 'cancel', transferId: b.id });
      this.sendControl(b.link, { t: 'cancel', id: b.id, reason: 'Benchmark stopped' });
      b.readyReject?.(new Error('Benchmark cancelled'));
      b.doneReject?.(new Error('Benchmark cancelled'));
      this.benchSenders.delete(b.id);
    }
  }

  getTransfers(): TransferRecord[] {
    return [...this.transfers.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  /** Pre-warms or awaits the dedicated primary WebRTC transport to `peerId`. */
  async ensureLink(peerId: string, peerName: string): Promise<PeerLink> {
    await this.workerReadyPromise;
    let link = this.links.get(peerId);
    if (link && (link.pc.connectionState === 'closed' || link.pc.connectionState === 'failed')) {
      this.teardownLink(link, null);
      link = undefined;
    }
    if (!link) {
      link = this.createPeerLink(peerId, peerName, 0, 'all', true);
    } else {
      if (peerName && peerName !== link.peerName) link.peerName = peerName;
      if (!link.makingOffer && !link.pc.localDescription && link.pc.signalingState === 'stable') {
        void this.emitInitialOffer(link);
      }
    }

    if (link.ctrl.readyState === 'open') return link;

    return new Promise<PeerLink>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out establishing direct P2P data channels'));
      }, 18_000);
      link!.openWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve(link!);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  warmPeer(peerId: string, peerName: string): void {
    if (this.links.has(peerId)) {
      const existing = this.links.get(peerId)!;
      if (peerName) existing.peerName = peerName;
      return;
    }
    if (this.isInitiatorFor(peerId)) {
      this.createPeerLink(peerId, peerName, 0, 'all', true);
    }
  }

  handlePeerLeft(peerId: string): void {
    const link = this.links.get(peerId);
    if (link) this.teardownLink(link, 'Peer went offline');
  }

  async handleSignal(peerId: string, peerName: string, payload: SignalWirePayload): Promise<void> {
    await this.workerReadyPromise;
    if (payload.kind === 'rebuild') {
      const current = this.links.get(peerId);
      if (current && current.gen >= payload.gen) return;
      if (current) this.teardownLink(current, null);
      this.createPeerLink(peerId, peerName, payload.gen, payload.targetStage, false);
      return;
    }

    let link = this.links.get(peerId);
    if (link && payload.gen > link.gen) {
      this.teardownLink(link, null);
      link = undefined;
    } else if (link && payload.gen < link.gen) {
      return;
    }

    if (!link) {
      link = this.createPeerLink(peerId, peerName, payload.gen, payload.stage, false);
    } else if (peerName && (!link.peerName || link.peerName === 'Peer')) {
      link.peerName = peerName;
    }

    const polite = !this.isInitiatorFor(peerId);
    const { pc } = link;

    try {
      if (payload.kind === 'sdp') {
        const desc = payload.description;
        const readyForOffer =
          !link.makingOffer && (pc.signalingState === 'stable' || link.isSettingRemoteAnswerPending);
        const offerCollision = desc.type === 'offer' && !readyForOffer;
        link.ignoreOffer = !polite && offerCollision;
        if (link.ignoreOffer) return;

        link.isSettingRemoteAnswerPending = desc.type === 'answer';
        await pc.setRemoteDescription(desc);
        link.isSettingRemoteAnswerPending = false;

        if (link.pendingCandidates.length > 0) {
          const queued = link.pendingCandidates.splice(0);
          for (const cand of queued) {
            try {
              await pc.addIceCandidate(cand);
            } catch {
              // Ignore superseded candidate.
            }
          }
        }

        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription) {
            this.callbacks.sendSignal(peerId, {
              gen: link.gen,
              stage: link.stage,
              kind: 'sdp',
              description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
            });
          }
        }
      } else if (payload.kind === 'ice') {
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          link.pendingCandidates.push(payload.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch (err) {
          if (!link.ignoreOffer) console.warn('[warp] addIceCandidate warning', err);
        }
      }
    } catch (error) {
      console.warn('[warp] signaling error', error);
    }
  }

  // ───────────────────────── File Transfers ─────────────────────────

  async sendFileOffer(peerId: string, peerName: string, file: File): Promise<string> {
    await this.workerReadyPromise;
    this.focusedPeerId = peerId;
    const id = randomId(8);
    const record: TransferRecord = {
      id,
      peerId,
      peerName,
      direction: 'send',
      fileName: file.name,
      fileSize: file.size,
      mime: file.type || 'application/octet-stream',
      entropy: 0,
      compressed: false,
      transport: 'blast-nack',
      retransmittedBlocks: 0,
      status: 'analyzing',
      bytesTransferred: 0,
      wireBytesTransferred: 0,
      throughputMBps: null,
      wireThroughputMBps: null,
      etaSeconds: null,
      compressionRatio: null,
      chunkSize: DEFAULT_CHUNK,
      activeChannels: CHANNEL_COUNT,
      activeLanes: 1,
      route: 'unknown',
      candidatePairLabel: 'standby',
      rttMs: null,
      sink: null,
      integrityVerified: null,
      finalizeMs: null,
      savedVia: null,
      errorMessage: null,
      startedAt: Date.now(),
      completedAt: null,
    };
    this.transfers.set(id, record);
    this.sourceFiles.set(id, file);
    this.emitTransfers();

    try {
      const verdict = await this.analyzeInWorker(id, file);
      record.entropy = Math.round(verdict.entropy * 100) / 100;
      record.compressed = verdict.compress && this.lz4Ready;
      record.status = 'connecting';
      this.emitTransfers();

      const link = await this.ensureLink(peerId, peerName);
      const rtt = link.telemetry.rttMs ?? link.pingRttMs;
      await this.initialTurboProbePromise;
      if (link.peerCaps.turboEndpoints && link.peerCaps.turboEndpoints.length > 0) {
        await this.probePeerTurboEndpoints(link);
      }
      const sharedTurbo = this.resolveSharedTurbo(link);
      const localBusReady = Boolean(link.localBusToken);
      const plan = negotiateJointTransferPlan(
        this.deviceProfile,
        link.peerCaps.hw,
        file.size,
        link.telemetry.route,
        rtt,
        this.transportMode,
        Boolean(link.peerCaps.blastNack),
        localBusReady,
        sharedTurbo?.localUrl ?? null,
      );
      record.transport = plan.transport;
      record.chunkSize = plan.initialChunk;
      record.activeLanes = plan.initialLanes;

      this.transferTransportMeta.set(id, {
        turboEndpoint: plan.transport === 'lan-turbo' ? (sharedTurbo?.localUrl ?? null) : null,
        turboInstanceId: plan.transport === 'lan-turbo' ? (sharedTurbo?.instanceId ?? null) : null,
        localBusToken: plan.transport === 'local-bus' ? link.localBusToken : null,
      });

      if (!link.seededByBench && plan.transport !== 'lan-turbo' && plan.transport !== 'local-bus') {
        this.postWorker({
          type: 'seed',
          linkId: link.linkId,
          config: {
            chunk: plan.initialChunk,
            lanes: plan.initialLanes,
            highWatermark: plan.initialWatermark,
            transport: plan.transport,
          },
        });
      }

      // Pre-spin clean background SCTP lanes for WebRTC transfers
      if (
        plan.transport !== 'lan-turbo' &&
        plan.transport !== 'local-bus' &&
        link.telemetry.route !== 'relay'
      ) {
        const targetExtra = Math.min(this.deviceProfile.maxExtraLanes, link.peerCaps.lanes || 3);
        if (targetExtra > 0) void this.ensureExtraLanes(link, targetExtra);
      }

      record.route = link.telemetry.route;
      record.candidatePairLabel = link.telemetry.candidatePairLabel;
      record.rttMs = rtt;
      record.status = 'offering';
      this.emitTransfers();

      const meta: FileOfferMeta = {
        id,
        name: file.name,
        size: file.size,
        mime: record.mime,
        lastModified: file.lastModified,
        compressed: record.compressed,
        entropy: record.entropy,
        transport: plan.transport,
        turboInstanceId: plan.transport === 'lan-turbo' ? (sharedTurbo?.instanceId ?? null) : null,
        localBusToken: plan.transport === 'local-bus' ? link.localBusToken : null,
      };
      this.sendControl(link, { t: 'offer', file: meta });
      return id;
    } catch (error) {
      this.sourceFiles.delete(id);
      record.status = 'failed';
      record.errorMessage = error instanceof Error ? error.message : String(error);
      this.emitTransfers();
      throw error;
    }
  }

  async acceptOffer(transferId: string): Promise<void> {
    const record = this.transfers.get(transferId);
    if (!record || record.direction !== 'receive' || record.status !== 'offered') return;

    const link = this.links.get(record.peerId);
    if (!link || link.ctrl.readyState !== 'open') {
      record.status = 'failed';
      record.errorMessage = 'Sender is no longer connected';
      this.emitTransfers();
      return;
    }

    const saveChoice = await chooseSaveTarget(record.fileName);
    if (saveChoice.kind === 'cancelled') return;

    // Direct OS FileSystemFileHandle (`DirectHandleSink`) and RAM Arena (`<= ramArenaBudget`)
    // write 0 bytes to browser OPFS storage, so OPFS quota only applies to large non-handle OPFS streams!
    const needsOpfsQuota =
      saveChoice.kind !== 'handle' && record.fileSize > this.deviceProfile.ramArenaBudget;
    if (needsOpfsQuota) {
      const quota = await hasQuotaFor(record.fileSize);
      if (!quota.ok) {
        record.status = 'failed';
        record.errorMessage = 'Insufficient browser storage quota — free disk space or use Chrome/Edge Save Picker';
        this.sendControl(link, { t: 'failed', id: transferId, reason: 'Receiver disk quota exceeded' });
        this.emitTransfers();
        return;
      }
    }

    record.savedVia = saveChoice.kind === 'handle' ? 'filesystem-handle' : 'opfs-download';
    record.status = 'transferring';
    record.startedAt = Date.now();
    this.speedHistory.set(transferId, [{ t: performance.now(), bytes: 0, wireBytes: 0 }]);
    this.emitTransfers();

    const meta = this.transferTransportMeta.get(transferId);
    this.postWorker({
      type: 'recv-start',
      linkId: link.linkId,
      transferId,
      name: record.fileName,
      mime: record.mime,
      size: record.fileSize,
      compress: record.compressed,
      transport: record.transport,
      turboEndpoint: meta?.turboEndpoint ?? null,
      localBusToken: meta?.localBusToken ?? null,
      saveHandle: saveChoice.kind === 'handle' ? saveChoice.handle : null,
      bench: false,
      preferredSink: 'auto',
      ramArenaBudget: this.deviceProfile.ramArenaBudget,
    });
  }

  declineOffer(transferId: string): void {
    const record = this.transfers.get(transferId);
    if (!record || record.direction !== 'receive' || record.status !== 'offered') return;
    record.status = 'declined';
    record.completedAt = Date.now();
    const link = this.links.get(record.peerId);
    if (link && link.ctrl.readyState === 'open') {
      this.sendControl(link, { t: 'decline', id: transferId });
    }
    this.emitTransfers();
  }

  pauseTransfer(transferId: string): void {
    const record = this.transfers.get(transferId);
    if (!record || record.status !== 'transferring') return;
    record.status = 'paused';
    record.throughputMBps = 0;
    record.wireThroughputMBps = 0;
    record.etaSeconds = null;
    this.speedHistory.delete(transferId);
    if (record.direction === 'send') {
      this.postWorker({ type: 'user-pause', transferId, paused: true });
    }
    const link = this.links.get(record.peerId);
    if (link && link.ctrl.readyState === 'open') {
      this.sendControl(link, { t: 'pause', id: transferId });
    }
    this.emitTransfers();
    this.emitHud();
  }

  resumeTransfer(transferId: string): void {
    const record = this.transfers.get(transferId);
    if (!record || record.status !== 'paused') return;
    record.status = 'transferring';
    this.speedHistory.set(transferId, [
      { t: performance.now(), bytes: record.bytesTransferred, wireBytes: record.wireBytesTransferred },
    ]);
    if (record.direction === 'send') {
      this.postWorker({ type: 'user-pause', transferId, paused: false });
    }
    const link = this.links.get(record.peerId);
    if (link && link.ctrl.readyState === 'open') {
      this.sendControl(link, { t: 'resume', id: transferId });
    }
    this.emitTransfers();
    this.emitHud();
  }

  cancelTransfer(transferId: string): void {
    const record = this.transfers.get(transferId);
    if (!record) return;
    if (record.status === 'completed' || record.status === 'cancelled' || record.status === 'declined') return;
    record.status = 'cancelled';
    record.throughputMBps = null;
    record.wireThroughputMBps = null;
    record.etaSeconds = null;
    record.completedAt = Date.now();
    this.sourceFiles.delete(transferId);
    this.speedHistory.delete(transferId);
    this.postWorker({ type: 'cancel', transferId });
    const link = this.links.get(record.peerId);
    if (link && link.ctrl.readyState === 'open') {
      this.sendControl(link, { t: 'cancel', id: transferId, reason: 'Cancelled by user' });
    }
    this.emitTransfers();
    this.emitHud();
  }

  clearFinishedTransfers(): void {
    for (const [id, rec] of this.transfers) {
      if (
        rec.status === 'completed' ||
        rec.status === 'cancelled' ||
        rec.status === 'declined' ||
        rec.status === 'failed'
      ) {
        this.transfers.delete(id);
      }
    }
    this.emitTransfers();
  }

  // ───────────────────────── Repeatable Benchmark Suite (P0–P6) ─────────────────────────

  async runBenchmarkSuite(
    peerId: string,
    peerName: string,
    preset: BenchmarkPresetId,
    userMeta: BenchmarkUserMetadata,
    onProgress?: (status: {
      stepIndex: number;
      totalSteps: number;
      stepLabel: string;
      completed: BenchmarkRunResult[];
    }) => void,
  ): Promise<BenchmarkSuiteSummary> {
    this.benchAborted = false;
    this.focusedPeerId = peerId;
    const link = await this.ensureLink(peerId, peerName);
    await this.refreshLinkStats(link);

    const maxExtra =
      link.telemetry.route === 'relay' ? 0 : Math.min(this.deviceProfile.maxExtraLanes, link.peerCaps.lanes);
    if (
      maxExtra > 0 &&
      (preset === 'quick-autotune' ||
        preset === 'blast-vs-reliable' ||
        preset === 'repeat-3x' ||
        preset === 'channel-lane-sweep')
    ) {
      await this.ensureExtraLanes(link, maxExtra);
    }

    await this.initialTurboProbePromise;
    if (link.peerCaps.turboEndpoints && link.peerCaps.turboEndpoints.length > 0) {
      await this.probePeerTurboEndpoints(link);
    }
    const sharedTurbo = this.resolveSharedTurbo(link);
    const localBusReady = Boolean(link.localBusToken);

    const totalPossibleLanes = 1 + link.extraLanes.size;
    const steps = buildPresetSteps(
      preset,
      link.pc.sctp?.maxMessageSize ?? null,
      totalPossibleLanes,
      this.opfsReady,
      this.opfsSyncReady,
      link.nativeWorkerChannels,
      Boolean(link.peerCaps.blastNack),
      Boolean(sharedTurbo),
      localBusReady,
    );

    const results: BenchmarkRunResult[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (this.benchAborted) throw new Error('Benchmark cancelled');
      const step = steps[i];
      onProgress?.({ stepIndex: i, totalSteps: steps.length, stepLabel: step.label, completed: [...results] });
      const res = await this.runSingleBenchmarkStep(link, step, userMeta);
      results.push(res);
      onProgress?.({ stepIndex: i + 1, totalSteps: steps.length, stepLabel: step.label, completed: [...results] });
      await new Promise((r) => setTimeout(r, 180));
    }

    const summary = summarizeBenchmarkSuite(preset, results);
    if (summary.recommendedConfig) {
      this.applyRecommendedConfig(peerId, summary.recommendedConfig);
    }
    return summary;
  }

  private async runSingleBenchmarkStep(
    link: PeerLink,
    step: BenchmarkStepSpec,
    userMeta: BenchmarkUserMetadata,
  ): Promise<BenchmarkRunResult> {
    const id = `bench-${randomId(6)}`;
    let tempBridgeLane: string | null = null;
    if (step.forceBridge && link.nativeWorkerChannels) {
      tempBridgeLane = await this.openTemporaryBridgeLane(link);
      this.syncBridgeStats(link);
    }

    const sharedTurbo = this.resolveSharedTurbo(link);
    const localBusReady = Boolean(link.localBusToken);
    const defaultPlan = negotiateJointTransferPlan(
      this.deviceProfile,
      link.peerCaps.hw,
      0,
      link.telemetry.route,
      link.telemetry.rttMs ?? link.pingRttMs,
      this.transportMode,
      Boolean(link.peerCaps.blastNack),
      localBusReady,
      sharedTurbo?.localUrl ?? null,
    );
    const stepTransport: ActiveTransportKind =
      step.transport ??
      step.pinned?.transport ??
      (step.forceBridge ? 'reliable-sctp' : defaultPlan.transport);

    try {
      const ctrlPingIdleMs = await this.measureControlPing(link, 800);
      const statsBefore = await this.sumAllLanesStats(link);
      const bridgeHandoffsBefore = link.bridgeHandoffs;
      const bridgeWaitBefore = link.bridgeWaitMs;

      const benchState: ActiveBenchSender = {
        id,
        link,
        setupStartedAt: performance.now(),
        setupMs: 0,
        readyResolve: null,
        readyReject: null,
        drainedData: null,
        remoteResult: null,
        doneResolve: null,
        doneReject: null,
      };
      this.benchSenders.set(id, benchState);

      const readyPromise = new Promise<{ window: number; sink: SinkKind }>((resolve, reject) => {
        benchState.readyResolve = resolve;
        benchState.readyReject = reject;
        setTimeout(() => reject(new Error('Receiver did not acknowledge benchmark start')), 10_000);
      });

      const donePromise = new Promise<void>((resolve, reject) => {
        benchState.doneResolve = resolve;
        benchState.doneReject = reject;
        setTimeout(() => reject(new Error('Timed out waiting for benchmark completion')), step.durationMs + 18_000);
      });

      this.sendControl(link, {
        t: 'bench-offer',
        id,
        compress: step.compress && this.lz4Ready,
        preferredSink: step.preferredSink,
        windowOverride: step.windowOverride,
        transport: stepTransport,
        turboInstanceId: stepTransport === 'lan-turbo' ? (sharedTurbo?.instanceId ?? null) : null,
        localBusToken: stepTransport === 'local-bus' ? link.localBusToken : null,
      });

      const { window: creditWindow, sink: negotiatedSink } = await readyPromise;
      benchState.setupMs = Math.round((performance.now() - benchState.setupStartedAt) * 10) / 10;

      const maxMsg = link.pc.sctp?.maxMessageSize ?? MAX_CHUNK + 64;
      this.postWorker({
        type: 'net',
        linkId: link.linkId,
        rttMs: link.telemetry.rttMs ?? link.pingRttMs ?? 1,
        maxMessageSize: maxMsg,
      });

      const streamStart = performance.now();
      let ctrlPingLoadedMs: number | null = null;
      const loadedPingTimer = setTimeout(() => {
        void this.measureControlPing(link, 1_200).then((ms) => {
          ctrlPingLoadedMs = ms;
        });
      }, Math.floor(step.durationMs * 0.5));

      this.postWorker({
        type: 'send-start',
        linkId: link.linkId,
        transferId: id,
        file: null,
        compressibleBench: step.compressible,
        forceBridge: Boolean(step.forceBridge),
        compress: step.compress && this.lz4Ready,
        transport: stepTransport,
        turboEndpoint: stepTransport === 'lan-turbo' ? (sharedTurbo?.localUrl ?? null) : null,
        localBusToken: stepTransport === 'local-bus' ? link.localBusToken : null,
        ignoreSeed: Boolean(step.transport || step.pinned || step.forceBridge),
        creditWindow,
        durationMs: step.durationMs,
        pinned: step.pinned ?? null,
      });

      await donePromise;
      clearTimeout(loadedPingTimer);

      const statsAfter = await this.sumAllLanesStats(link);
      const wallElapsedSec = Math.max(0.001, (performance.now() - streamStart) / 1000);
      const drained = benchState.drainedData!;
      const remote = benchState.remoteResult!;

      const elapsedMs = Math.max(drained.elapsedMs, remote.elapsedMs, 1);
      const appMBps = Math.round((remote.bytes / (1024 * 1024) / (elapsedMs / 1000)) * 10) / 10;
      const wireMBps = Math.round((drained.wireBytes / (1024 * 1024) / (elapsedMs / 1000)) * 10) / 10;
      const statsDeltaBytes = Math.max(0, statsAfter.bytesSent - statsBefore.bytesSent);
      const statsWireMBps = Math.round((statsDeltaBytes / (1024 * 1024) / wallElapsedSec) * 10) / 10;

      const receiverWriteMBps =
        remote.sink !== 'discard' && remote.writeMs > 2
          ? Math.round((remote.bytes / (1024 * 1024) / (remote.writeMs / 1000)) * 10) / 10
          : null;

      const finalTuner = drained.finalTuner;
      const usedBridge = Boolean(step.forceBridge) || !link.nativeWorkerChannels;

      return {
        id,
        label: step.label,
        warmup: Boolean(step.warmup),
        timestamp: new Date().toISOString(),
        route:
          stepTransport === 'local-bus'
            ? 'host'
            : stepTransport === 'lan-turbo'
              ? 'host'
              : statsAfter.primary.route,
        candidatePairLabel:
          stepTransport === 'local-bus'
            ? 'local-bus ⇄ shared-ram'
            : stepTransport === 'lan-turbo'
              ? `lan-turbo ⇄ ${sharedTurbo?.localUrl ?? 'tcp'}`
              : statsAfter.primary.candidatePairLabel,
        localCandidateType:
          stepTransport === 'local-bus' ? 'ram' : stepTransport === 'lan-turbo' ? 'tcp' : statsAfter.primary.localCandidateType,
        remoteCandidateType:
          stepTransport === 'local-bus' ? 'ram' : stepTransport === 'lan-turbo' ? 'tcp' : statsAfter.primary.remoteCandidateType,
        protocol:
          stepTransport === 'local-bus' ? 'ipc' : stepTransport === 'lan-turbo' ? 'tcp' : statsAfter.primary.protocol,
        relayProtocol: statsAfter.primary.relayProtocol,
        rttMs: statsAfter.primary.rttMs ?? link.pingRttMs,
        minRttMs: finalTuner.minRttMs ?? null,
        bloatMs: finalTuner.bloatMs ?? 0,
        ctrlPingIdleMs,
        ctrlPingLoadedMs,
        availableOutgoingBitrateMbps: statsAfter.primary.availableOutgoingBitrate
          ? Math.round((statsAfter.primary.availableOutgoingBitrate / 1_000_000) * 10) / 10
          : null,
        bytes: remote.bytes,
        wireBytes: drained.wireBytes,
        setupMs: benchState.setupMs,
        elapsedMs: Math.round(elapsedMs),
        receiverFinalizeMs: Math.round(remote.finalizeMs * 10) / 10,
        appMBps,
        wireMBps,
        statsWireMBps,
        compressionRatio:
          drained.wireBytes > 0 ? Math.round((drained.rawBytes / drained.wireBytes) * 100) / 100 : 1,
        transport: finalTuner.transport,
        chunkSize: finalTuner.chunk,
        activeLanes: usedBridge ? 1 : finalTuner.lanes,
        activeChannels: finalTuner.channels ?? CHANNEL_COUNT,
        schedule: finalTuner.schedule ?? 'least-buffered',
        highWatermark: finalTuner.highWatermark,
        workerMode: usedBridge ? 'transferable-bridge' : 'native-worker-dc',
        bridgeHandoffs: Math.max(0, link.bridgeHandoffs - bridgeHandoffsBefore),
        bridgeWaitMs: Math.round((link.bridgeWaitMs - bridgeWaitBefore) * 10) / 10,
        queueWaitPct: Math.min(100, Math.round((drained.queueWaitMs / Math.max(1, drained.elapsedMs)) * 100)),
        creditWaitPct: Math.min(100, Math.round((drained.creditWaitMs / Math.max(1, drained.elapsedMs)) * 100)),
        diskWaitPct: Math.min(100, Math.round((drained.diskWaitMs / Math.max(1, drained.elapsedMs)) * 100)),
        retransmittedBlocks: drained.retransmittedBlocks,
        duplicateBlocks: remote.duplicateBlocks,
        bottleneck: finalTuner.bottleneck,
        tunerDecision: finalTuner.lastDecision,
        sink: remote.sink ?? negotiatedSink,
        receiverWriteMs: Math.round(remote.writeMs * 10) / 10,
        receiverWriteMBps,
        maxPendingWriteBytes: remote.maxPendingWriteBytes,
        creditWindowBytes: creditWindow,
        senderHash: drained.hash,
        receiverHash: remote.hash,
        hashMatch: drained.hash === remote.hash && remote.bytes === drained.rawBytes,
        complete: remote.complete && remote.bytes === drained.rawBytes,
        senderEnv: this.selfHw?.summary ?? this.deviceProfile.summary,
        receiverEnv: link.peerCaps.hw?.summary ?? link.peerCaps.userAgentSummary ?? link.peerName,
        networkTag: userMeta.networkTag,
        powerTag: userMeta.powerTag,
      };
    } finally {
      this.benchSenders.delete(id);
      if (tempBridgeLane) {
        this.closeExtraLane(link, tempBridgeLane, true);
      }
    }
  }

  private measureControlPing(link: PeerLink, timeoutMs: number): Promise<number | null> {
    if (link.ctrl.readyState !== 'open') return Promise.resolve(null);
    return new Promise((resolve) => {
      const probeId = randomId(4);
      const timer = setTimeout(() => {
        link.pingWaiters.delete(probeId);
        resolve(null);
      }, timeoutMs);
      link.pingWaiters.set(probeId, (rtt) => {
        clearTimeout(timer);
        resolve(rtt);
      });
      this.sendControl(link, { t: 'ping', ts: performance.now(), probeId });
    });
  }

  dispose(): void {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    if (this.turboProbeTimer) clearInterval(this.turboProbeTimer);
    if (this.busProbeChannel) {
      try {
        this.busProbeChannel.close();
      } catch {
        // Ignore.
      }
      this.busProbeChannel = null;
    }
    this.cancelBenchmarks();
    for (const link of [...this.links.values()]) this.teardownLink(link, null);
    this.worker.terminate();
  }

  // ───────────────────────── Internal: Link & Multi-Lane Lifecycle ─────────────────────────

  private isInitiatorFor(peerId: string): boolean {
    return this.selfId > peerId;
  }

  private createPeerLink(
    peerId: string,
    peerName: string,
    gen: number,
    stage: CascadeStage,
    startNegotiation: boolean,
  ): PeerLink {
    const linkId = `${peerId}:${gen}:${randomId(4)}`;
    const pc = new RTCPeerConnection(buildRtcConfig(stage));

    const ctrl = pc.createDataChannel('warp-ctrl', { negotiated: true, id: 0, ordered: true });
    const dataChannels: RTCDataChannel[] = [];
    const blastChannels: RTCDataChannel[] = [];
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      dataChannels.push(
        pc.createDataChannel(`warp-${i}`, {
          negotiated: true,
          id: i + 1,
          ordered: false,
        }),
      );
      blastChannels.push(
        pc.createDataChannel(`warp-blast-${i}`, {
          negotiated: true,
          id: CHANNEL_COUNT + 1 + i,
          ordered: false,
          maxRetransmits: 0,
        }),
      );
    }

    const link: PeerLink = {
      linkId,
      peerId,
      peerName: peerName || 'Peer',
      gen,
      stage,
      pc,
      ctrl,
      dataChannels,
      blastChannels,
      bridgePool: null,
      blastBridgePool: null,
      nativeWorkerChannels: false,
      peerCaps: { lanes: 0, credit: false, bench: false },
      localBusToken: null,
      peerLanTurboUrl: null,
      seededByBench: false,
      extraLanes: new Map(),
      cascade: new IceCascadeMonitor(pc, startNegotiation || this.isInitiatorFor(peerId), {
        onRestartIce: () => this.performIceRestart(link),
        onEscalateRelayOnly: () => this.escalateToRelayOnly(link),
        onRouteChanged: (snap) => {
          link.telemetry = snap;
          this.syncActiveTransferRoute(link);
          this.callbacks.onPeerLinkState?.(
            link.peerId,
            link.pc.connectionState,
            snap.route,
            snap.rttMs ?? link.pingRttMs,
          );
          if (snap.route === 'host' && this.isInitiatorFor(link.peerId) && (link.peerCaps.lanes ?? 0) > 0) {
            const desiredExtra = Math.min(this.deviceProfile.maxExtraLanes, link.peerCaps.lanes);
            if (desiredExtra > 0) void this.ensureExtraLanes(link, desiredExtra);
          }
          this.emitHud();
        },
      }),
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      pendingCandidates: [],
      openWaiters: [],
      telemetry: emptyTelemetrySnapshot(),
      statsWireMBps: 0,
      lastStatsSample: null,
      pingRttMs: null,
      pingWaiters: new Map(),
      buffered: [0, 0, 0, 0],
      channelLaneIds: ['0', '0', '0', '0'],
      activeChannels: CHANNEL_COUNT,
      highWatermark: INITIAL_HIGH_WATERMARK,
      lowWatermark: LOW_WATERMARK,
      lastTuner: null,
      lastSink: null,
      receiverPendingBytes: 0,
      pendingAckBytes: 0,
      ackScheduled: false,
      pendingBlastAckBytes: 0,
      blastAckScheduled: false,
      bridgeHandoffs: 0,
      bridgeWaitMs: 0,
      disposed: false,
    };

    let transferredToWorker = false;
    try {
      this.worker.postMessage(
        {
          type: 'attach-channels',
          linkId,
          lane: '0',
          channelKind: 'reliable',
          channels: dataChannels,
        } satisfies ToWorker,
        dataChannels as unknown as Transferable[],
      );
      this.worker.postMessage(
        {
          type: 'attach-channels',
          linkId,
          lane: '0',
          channelKind: 'blast',
          channels: blastChannels,
        } satisfies ToWorker,
        blastChannels as unknown as Transferable[],
      );
      transferredToWorker = true;
    } catch {
      transferredToWorker = false;
    }

    if (transferredToWorker) {
      link.nativeWorkerChannels = true;
    } else {
      this.attachLaneToBridgePool(link, '0', dataChannels, blastChannels);
    }

    this.wireControlChannel(link);
    this.wirePeerConnection(link, startNegotiation);

    this.links.set(peerId, link);
    this.linkById.set(linkId, link);
    if (!this.focusedPeerId) this.focusedPeerId = peerId;
    this.emitHud();
    return link;
  }

  /**
   * Wires trickle-ICE candidate gathering with a strict LAN `typ host` head-start:
   *  • When `typ host` candidates exist during `stage === 'all'`, `srflx` / `relay`
   *    candidates are held back for `HOST_HEAD_START_MS` (650 ms).
   *  • If the connection ALREADY reaches `connected`/`completed` using only `host`
   *    candidates, the deferred NAT-hairpin `srflx` candidates are NEVER sent unless
   *    ICE later drops to `disconnected` or `failed`.
   */
  private wireHostPriorityIce(
    pc: RTCPeerConnection,
    stage: CascadeStage,
    isDisposed: () => boolean,
    emitCandidate: (candidate: RTCIceCandidateInit) => void,
  ): void {
    const deferredNonHost: RTCIceCandidateInit[] = [];
    let deferTimer: ReturnType<typeof setTimeout> | null = null;
    let sawHostCandidate = false;

    const isDirectConnected = () =>
      pc.iceConnectionState === 'connected' ||
      pc.iceConnectionState === 'completed' ||
      pc.connectionState === 'connected';

    const flushDeferred = (force = false) => {
      if (deferTimer !== null) {
        clearTimeout(deferTimer);
        deferTimer = null;
      }
      if (isDisposed() || deferredNonHost.length === 0) return;
      if (!force && isDirectConnected()) {
        return;
      }
      const batch = deferredNonHost.splice(0);
      for (const candidate of batch) emitCandidate(candidate);
    };

    pc.addEventListener('iceconnectionstatechange', () => {
      if (isDisposed()) return;
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        flushDeferred(true);
      }
    });

    pc.addEventListener('icecandidate', (event) => {
      if (isDisposed()) return;
      if (!event.candidate) {
        flushDeferred(false);
        return;
      }
      const json = event.candidate.toJSON();
      const candStr = json.candidate ?? '';
      const isHost = /\btyp\s+host\b/i.test(candStr);
      if (isHost) {
        sawHostCandidate = true;
        emitCandidate(json);
        return;
      }

      if (stage === 'all' && sawHostCandidate) {
        deferredNonHost.push(json);
        if (!isDirectConnected() && deferTimer === null) {
          deferTimer = setTimeout(() => flushDeferred(false), HOST_HEAD_START_MS);
        }
        return;
      }

      emitCandidate(json);
    });
  }

  private wirePeerConnection(link: PeerLink, startNegotiation: boolean): void {
    const { pc } = link;

    this.wireHostPriorityIce(
      pc,
      link.stage,
      () => link.disposed,
      (candidate) =>
        this.callbacks.sendSignal(link.peerId, {
          gen: link.gen,
          stage: link.stage,
          kind: 'ice',
          candidate,
        }),
    );

    pc.addEventListener('negotiationneeded', () => {
      if (link.disposed || !startNegotiation) return;
      void this.emitInitialOffer(link);
    });

    if (startNegotiation) {
      queueMicrotask(() => {
        if (!link.disposed && !link.makingOffer && !pc.localDescription && pc.signalingState === 'stable') {
          void this.emitInitialOffer(link);
        }
      });
    }

    pc.addEventListener('connectionstatechange', () => {
      if (link.disposed) return;
      const state = pc.connectionState;
      this.callbacks.onPeerLinkState?.(
        link.peerId,
        state,
        link.telemetry.route,
        link.telemetry.rttMs ?? link.pingRttMs,
      );
      if (state === 'closed') {
        this.teardownLink(link, 'Connection closed');
      }
      this.emitHud();
    });
  }

  // ───────────────────────── Parallel SCTP Lanes (L1..LN & Bridge Bench Lb) ─────────────────────────

  private async ensureExtraLanes(link: PeerLink, desiredCount: number): Promise<void> {
    if (link.disposed || link.ctrl.readyState !== 'open') return;
    const promises: Promise<void>[] = [];
    for (let i = 1; i <= desiredCount; i++) {
      const laneId = `L${i}`;
      let lane = link.extraLanes.get(laneId);
      if (!lane || lane.closed || lane.pc.connectionState === 'failed' || lane.pc.connectionState === 'closed') {
        lane = this.createExtraLane(link, laneId, LANE_CHANNELS, false, true);
      }
      if (!lane.channels.some((c) => c.readyState === 'open')) {
        promises.push(
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 2_500);
            lane!.openWaiters.push(() => {
              clearTimeout(t);
              resolve();
            });
          }),
        );
      }
    }
    if (promises.length > 0) await Promise.all(promises);
  }

  private async openTemporaryBridgeLane(link: PeerLink): Promise<string> {
    const laneId = `B${randomId(2)}`;
    const lane = this.createExtraLane(link, laneId, CHANNEL_COUNT, true, true);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Bridge benchmark lane timed out')), 6_000);
      lane.openWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
    return laneId;
  }

  private createExtraLane(
    link: PeerLink,
    laneId: string,
    channelCount: number,
    bridgeOnly: boolean,
    initiate: boolean,
  ): ExtraLane {
    this.closeExtraLane(link, laneId, false);
    const pc = new RTCPeerConnection(buildRtcConfig(link.stage));
    const channels: RTCDataChannel[] = [];
    const blastChannels: RTCDataChannel[] = [];
    for (let i = 0; i < channelCount; i++) {
      channels.push(
        pc.createDataChannel(`warp-${laneId}-${i}`, {
          negotiated: true,
          id: i,
          ordered: false,
        }),
      );
      blastChannels.push(
        pc.createDataChannel(`warp-${laneId}-blast-${i}`, {
          negotiated: true,
          id: channelCount + i,
          ordered: false,
          maxRetransmits: 0,
        }),
      );
    }

    const lane: ExtraLane = {
      id: laneId,
      pc,
      channels,
      blastChannels,
      bridgeOnly,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      pendingCandidates: [],
      openWaiters: [],
      closed: false,
    };
    link.extraLanes.set(laneId, lane);

    const notifyOpen = () => {
      const waiters = lane.openWaiters.splice(0);
      for (const w of waiters) w();
    };
    for (const ch of channels) {
      ch.addEventListener('open', notifyOpen, { once: true });
    }

    const isBridgeLane = bridgeOnly || laneId.startsWith('B') || !link.nativeWorkerChannels;
    if (!isBridgeLane) {
      try {
        this.worker.postMessage(
          {
            type: 'attach-channels',
            linkId: link.linkId,
            lane: laneId,
            channelKind: 'reliable',
            channels,
          } satisfies ToWorker,
          channels as unknown as Transferable[],
        );
        this.worker.postMessage(
          {
            type: 'attach-channels',
            linkId: link.linkId,
            lane: laneId,
            channelKind: 'blast',
            channels: blastChannels,
          } satisfies ToWorker,
          blastChannels as unknown as Transferable[],
        );
      } catch {
        this.attachLaneToBridgePool(link, laneId, channels, blastChannels);
      }
    } else {
      this.attachLaneToBridgePool(link, laneId, channels, blastChannels);
    }

    this.wireHostPriorityIce(
      pc,
      link.stage,
      () => link.disposed || lane.closed,
      (candidate) => this.sendControl(link, { t: 'lane-ice', lane: laneId, candidate }),
    );

    if (initiate) {
      queueMicrotask(async () => {
        if (link.disposed || lane.closed) return;
        try {
          lane.makingOffer = true;
          await pc.setLocalDescription();
          if (pc.localDescription && !lane.closed) {
            this.sendControl(link, {
              t: 'lane-sdp',
              lane: laneId,
              description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
            });
          }
        } catch (err) {
          console.warn('[warp] extra lane offer failed', err);
        } finally {
          lane.makingOffer = false;
        }
      });
    }

    return lane;
  }

  private attachLaneToBridgePool(
    link: PeerLink,
    laneId: string,
    channels: RTCDataChannel[],
    blastChannels: RTCDataChannel[],
  ): void {
    if (!link.bridgePool) {
      const pool = new ChannelPool();
      pool.onValve((open) => {
        this.postWorker({ type: 'flow', linkId: link.linkId, paused: !open, blast: false });
      });
      link.bridgePool = pool;
    }
    if (!link.blastBridgePool) {
      const blastPool = new ChannelPool();
      blastPool.onValve((open) => {
        this.postWorker({ type: 'flow', linkId: link.linkId, paused: !open, blast: true });
      });
      link.blastBridgePool = blastPool;
    }
    link.bridgePool.addLane(laneId, channels);
    link.blastBridgePool.addLane(laneId, blastChannels);

    for (const ch of [...channels, ...blastChannels]) {
      ch.addEventListener('open', () => {
        if (!link.disposed) this.syncBridgeStats(link);
      });
      ch.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
        if (event.data instanceof ArrayBuffer) {
          this.worker.postMessage(
            { type: 'chunk-in', linkId: link.linkId, data: event.data } satisfies ToWorker,
            [event.data],
          );
        }
      });
    }
  }

  private syncBridgeStats(link: PeerLink): void {
    if (!link.bridgePool) return;
    const activePool =
      link.blastBridgePool && link.blastBridgePool.totalBuffered > 0 ? link.blastBridgePool : link.bridgePool;
    link.buffered = activePool.bufferedAmounts;
    link.channelLaneIds = activePool.channelLaneIds;
    link.activeChannels = activePool.activeChannelCount;
    this.postWorker({
      type: 'bridge-stats',
      linkId: link.linkId,
      sentBytes: link.bridgePool.sentBytes,
      buffered: link.bridgePool.bufferedAmounts,
      openLanes: link.bridgePool.openLaneCount,
      blastSentBytes: link.blastBridgePool?.sentBytes ?? 0,
      blastBuffered: link.blastBridgePool?.bufferedAmounts ?? [],
      blastOpenLanes: link.blastBridgePool?.openLaneCount ?? 0,
    });
  }

  private closeExtraLane(link: PeerLink, laneId: string, notifyRemote: boolean): void {
    const lane = link.extraLanes.get(laneId);
    if (!lane) return;
    lane.closed = true;
    link.extraLanes.delete(laneId);
    link.bridgePool?.removeLane(laneId);
    link.blastBridgePool?.removeLane(laneId);
    this.postWorker({ type: 'detach-lane', linkId: link.linkId, lane: laneId });
    try {
      lane.pc.close();
    } catch {
      // Ignore.
    }
    if (notifyRemote) {
      this.sendControl(link, { t: 'lane-close', lane: laneId });
    }
  }

  private async handleLaneSdp(
    link: PeerLink,
    laneId: string,
    desc: RTCSessionDescriptionInit,
  ): Promise<void> {
    let lane = link.extraLanes.get(laneId);
    if (!lane) {
      const chCount = laneId.startsWith('B') ? CHANNEL_COUNT : LANE_CHANNELS;
      lane = this.createExtraLane(link, laneId, chCount, laneId.startsWith('B'), false);
    }
    const polite = !this.isInitiatorFor(link.peerId);
    const { pc } = lane;
    try {
      const readyForOffer =
        !lane.makingOffer && (pc.signalingState === 'stable' || lane.isSettingRemoteAnswerPending);
      const offerCollision = desc.type === 'offer' && !readyForOffer;
      lane.ignoreOffer = !polite && offerCollision;
      if (lane.ignoreOffer) return;

      lane.isSettingRemoteAnswerPending = desc.type === 'answer';
      await pc.setRemoteDescription(desc);
      lane.isSettingRemoteAnswerPending = false;

      if (lane.pendingCandidates.length > 0) {
        for (const cand of lane.pendingCandidates.splice(0)) {
          await pc.addIceCandidate(cand).catch(() => undefined);
        }
      }
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.sendControl(link, {
            t: 'lane-sdp',
            lane: laneId,
            description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        }
      }
    } catch (err) {
      console.warn('[warp] extra lane SDP error', err);
    }
  }

  private async handleLaneIce(link: PeerLink, laneId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const lane = link.extraLanes.get(laneId);
    if (!lane) return;
    if (!lane.pc.remoteDescription || !lane.pc.remoteDescription.type) {
      lane.pendingCandidates.push(candidate);
      return;
    }
    await lane.pc.addIceCandidate(candidate).catch(() => undefined);
  }

  private async emitInitialOffer(link: PeerLink): Promise<void> {
    if (link.disposed || link.makingOffer || link.pc.signalingState !== 'stable') return;
    try {
      link.makingOffer = true;
      await link.pc.setLocalDescription();
      if (link.pc.localDescription && !link.disposed) {
        this.callbacks.sendSignal(link.peerId, {
          gen: link.gen,
          stage: link.stage,
          kind: 'sdp',
          description: { type: link.pc.localDescription.type, sdp: link.pc.localDescription.sdp },
        });
      }
    } catch (err) {
      console.warn('[warp] emitInitialOffer failed', err);
    } finally {
      link.makingOffer = false;
    }
  }

  private wireControlChannel(link: PeerLink): void {
    const { ctrl } = link;
    ctrl.addEventListener('open', () => {
      if (link.disposed) return;
      this.sendControl(link, {
        t: 'hello',
        name: this.selfName,
        deviceKind: this.selfDeviceKind,
        caps: this.selfCaps,
      });
      this.sendControl(link, { t: 'ping', ts: performance.now() });
      const waiters = link.openWaiters.splice(0);
      for (const w of waiters) w.resolve();
      void link.cascade.refreshTelemetry().then((snap) => {
        link.telemetry = snap;
        this.callbacks.onPeerLinkState?.(
          link.peerId,
          link.pc.connectionState,
          snap.route,
          snap.rttMs ?? link.pingRttMs,
        );
        this.emitHud();
      });
    });

    ctrl.addEventListener('message', (event: MessageEvent<string>) => {
      if (link.disposed || typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data) as ControlMessage;
        this.handleControlMessage(link, msg);
      } catch (err) {
        console.warn('[warp] malformed control message', err);
      }
    });

    ctrl.addEventListener('close', () => {
      if (link.disposed) return;
      this.teardownLink(link, 'Peer closed connection');
    });
  }

  private performIceRestart(link: PeerLink): void {
    if (link.disposed || link.pc.signalingState === 'closed') return;
    void (async () => {
      try {
        link.makingOffer = true;
        if (typeof link.pc.restartIce === 'function') link.pc.restartIce();
        const offer = await link.pc.createOffer({ iceRestart: true });
        await link.pc.setLocalDescription(offer);
        if (link.pc.localDescription) {
          this.callbacks.sendSignal(link.peerId, {
            gen: link.gen,
            stage: link.stage,
            kind: 'sdp',
            description: { type: link.pc.localDescription.type, sdp: link.pc.localDescription.sdp },
          });
        }
      } catch (err) {
        console.warn('[warp] ICE restart failed, escalating to TURN relay', err);
        this.escalateToRelayOnly(link);
      } finally {
        link.makingOffer = false;
      }
    })();
  }

  private escalateToRelayOnly(link: PeerLink): void {
    if (link.disposed || link.stage === 'relay-only') return;
    const nextGen = link.gen + 1;
    const savedWaiters = link.openWaiters.splice(0);
    const { peerId, peerName } = link;
    this.teardownLink(link, null);
    this.callbacks.sendSignal(peerId, {
      gen: nextGen,
      stage: 'relay-only',
      kind: 'rebuild',
      targetStage: 'relay-only',
    });
    const rebuilt = this.createPeerLink(peerId, peerName, nextGen, 'relay-only', true);
    rebuilt.openWaiters.push(...savedWaiters);
  }

  private teardownLink(link: PeerLink, failReason: string | null): void {
    if (link.disposed) return;
    link.disposed = true;
    if (this.links.get(link.peerId) === link) this.links.delete(link.peerId);
    this.linkById.delete(link.linkId);

    for (const laneId of [...link.extraLanes.keys()]) {
      this.closeExtraLane(link, laneId, false);
    }
    link.cascade.dispose();
    link.bridgePool?.dispose();
    link.blastBridgePool?.dispose();
    this.postWorker({ type: 'detach', linkId: link.linkId });

    try {
      link.ctrl.close();
    } catch {
      // Ignore.
    }
    try {
      link.pc.close();
    } catch {
      // Ignore.
    }

    const waiters = link.openWaiters.splice(0);
    for (const w of waiters) w.reject(new Error(failReason ?? 'Link replaced'));
    for (const [benchId, recvLink] of this.benchRecvLinks) {
      if (recvLink === link) this.benchRecvLinks.delete(benchId);
    }
    for (const [benchId, sender] of this.benchSenders) {
      if (sender.link === link) {
        sender.readyReject?.(new Error(failReason ?? 'Link closed during benchmark'));
        sender.doneReject?.(new Error(failReason ?? 'Link closed during benchmark'));
        this.benchSenders.delete(benchId);
      }
    }

    if (failReason) {
      let changed = false;
      for (const rec of this.transfers.values()) {
        if (
          rec.peerId === link.peerId &&
          (rec.status === 'offering' ||
            rec.status === 'offered' ||
            rec.status === 'connecting' ||
            rec.status === 'transferring' ||
            rec.status === 'flushing' ||
            rec.status === 'paused')
        ) {
          rec.status = 'failed';
          rec.errorMessage = failReason;
          rec.throughputMBps = null;
          rec.wireThroughputMBps = null;
          rec.etaSeconds = null;
          this.sourceFiles.delete(rec.id);
          this.speedHistory.delete(rec.id);
          changed = true;
        }
      }
      if (changed) this.emitTransfers();
    }
    this.emitHud();
  }

  // ───────────────────────── Control Protocol ─────────────────────────

  private sendControl(link: PeerLink, msg: ControlMessage): void {
    if (link.ctrl.readyState !== 'open') return;
    try {
      link.ctrl.send(JSON.stringify(msg));
    } catch (err) {
      console.warn('[warp] ctrl send error', err);
    }
  }

  private handleControlMessage(link: PeerLink, msg: ControlMessage): void {
    switch (msg.t) {
      case 'hello':
        link.peerName = msg.name || link.peerName;
        if (msg.caps) {
          link.peerCaps = msg.caps;
          link.peerLanTurboUrl =
            msg.caps.turboEndpoints?.find((u) => !u.includes('127.0.0.1') && !u.includes('localhost')) ?? null;
          if (msg.caps.localBusId && this.busProbeChannel) {
            const token = link.localBusToken ?? [this.selfId, link.peerId].sort().join(':');
            this.busProbeChannel.postMessage({
              targetBusId: msg.caps.localBusId,
              senderPeerId: this.selfId,
              token,
            });
          }
          void this.probePeerTurboEndpoints(link);
          const desiredExtra = Math.min(this.deviceProfile.maxExtraLanes, msg.caps.lanes ?? 3);
          if (desiredExtra > 0 && this.isInitiatorFor(link.peerId) && link.telemetry.route !== 'relay') {
            void this.ensureExtraLanes(link, desiredExtra);
          }
        }
        this.callbacks.onRemoteHello?.(link.peerId, link.peerName, msg.deviceKind);
        this.emitHud();
        break;
      case 'local-bus-ack':
        link.localBusToken = msg.token;
        this.emitHud();
        break;
      case 'ping':
        this.sendControl(link, { t: 'pong', ts: msg.ts, probeId: msg.probeId });
        break;
      case 'pong': {
        const rtt = Math.max(0.1, Math.round((performance.now() - msg.ts) * 10) / 10);
        link.pingRttMs = rtt;
        if (msg.probeId) {
          const waiter = link.pingWaiters.get(msg.probeId);
          if (waiter) {
            link.pingWaiters.delete(msg.probeId);
            waiter(rtt);
          }
        }
        break;
      }
      case 'lane-sdp':
        void this.handleLaneSdp(link, msg.lane, msg.description);
        break;
      case 'lane-ice':
        void this.handleLaneIce(link, msg.lane, msg.candidate);
        break;
      case 'lane-close':
        this.closeExtraLane(link, msg.lane, false);
        break;
      case 'credit':
        this.postWorker({ type: 'credit', transferId: msg.id, bytes: msg.bytes });
        break;
      case 'eof-blast':
        this.postWorker({ type: 'blast-eof-in', transferId: msg.id, totalBytes: msg.totalBytes });
        break;
      case 'nack-report':
        this.postWorker({
          type: 'nack-in',
          transferId: msg.id,
          receivedBlocks: msg.receivedBlocks,
          totalBlocks: msg.totalBlocks,
          ranges: msg.ranges,
          finalAudit: msg.finalAudit,
        });
        break;
      case 'offer': {
        this.focusedPeerId = link.peerId;
        const { file } = msg;
        let resolvedTransport: ActiveTransportKind = file.transport ?? 'reliable-sctp';
        let turboRxUrl: string | null = null;
        if (resolvedTransport === 'lan-turbo') {
          turboRxUrl =
            (file.turboInstanceId && this.reachableTurboByInstance.get(file.turboInstanceId)) || null;
          if (!turboRxUrl) resolvedTransport = 'blast-nack';
        }
        this.transferTransportMeta.set(file.id, {
          turboEndpoint: turboRxUrl,
          turboInstanceId: file.turboInstanceId ?? null,
          localBusToken: resolvedTransport === 'local-bus' ? (file.localBusToken ?? null) : null,
        });
        const rec: TransferRecord = {
          id: file.id,
          peerId: link.peerId,
          peerName: link.peerName,
          direction: 'receive',
          fileName: file.name,
          fileSize: file.size,
          mime: file.mime,
          entropy: file.entropy,
          compressed: file.compressed,
          transport: resolvedTransport,
          retransmittedBlocks: 0,
          status: 'offered',
          bytesTransferred: 0,
          wireBytesTransferred: 0,
          throughputMBps: null,
          wireThroughputMBps: null,
          etaSeconds: null,
          compressionRatio: null,
          chunkSize: DEFAULT_CHUNK,
          activeChannels: CHANNEL_COUNT,
          activeLanes: 1 + link.extraLanes.size,
          route: link.telemetry.route,
          candidatePairLabel: link.telemetry.candidatePairLabel,
          rttMs: link.telemetry.rttMs ?? link.pingRttMs,
          sink: null,
          integrityVerified: null,
          finalizeMs: null,
          savedVia: null,
          errorMessage: null,
          startedAt: Date.now(),
          completedAt: null,
        };
        this.transfers.set(file.id, rec);
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'accept': {
        const rec = this.transfers.get(msg.id);
        const file = this.sourceFiles.get(msg.id);
        if (!rec || !file || rec.direction !== 'send') return;
        const maxSctp = link.pc.sctp?.maxMessageSize ?? MAX_CHUNK + 64;
        this.postWorker({
          type: 'net',
          linkId: link.linkId,
          rttMs: link.telemetry.rttMs ?? link.pingRttMs ?? 1,
          maxMessageSize: maxSctp,
        });
        if (link.bridgePool) this.syncBridgeStats(link);
        rec.sink = msg.sink ?? null;
        if (msg.transport) rec.transport = msg.transport;
        const meta = this.transferTransportMeta.get(rec.id);
        const effectiveTurboEndpoint =
          rec.transport === 'lan-turbo' ? (meta?.turboEndpoint ?? null) : null;
        const effectiveLocalBusToken =
          rec.transport === 'local-bus' ? (meta?.localBusToken ?? msg.localBusToken ?? null) : null;
        rec.status = 'transferring';
        rec.startedAt = Date.now();
        this.speedHistory.set(rec.id, [{ t: performance.now(), bytes: 0, wireBytes: 0 }]);
        this.postWorker({
          type: 'send-start',
          linkId: link.linkId,
          transferId: rec.id,
          file,
          compress: rec.compressed,
          transport: rec.transport,
          turboEndpoint: effectiveTurboEndpoint,
          localBusToken: effectiveLocalBusToken,
          creditWindow: msg.window && msg.window > 0 ? msg.window : Number.POSITIVE_INFINITY,
          ramPreloadBudget: this.deviceProfile.senderRamPreloadBudget,
        });
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'decline': {
        const rec = this.transfers.get(msg.id);
        if (!rec) return;
        rec.status = 'declined';
        rec.completedAt = Date.now();
        this.sourceFiles.delete(msg.id);
        this.emitTransfers();
        break;
      }
      case 'pause': {
        const rec = this.transfers.get(msg.id);
        if (!rec || rec.status !== 'transferring') return;
        rec.status = 'paused';
        rec.throughputMBps = 0;
        rec.wireThroughputMBps = 0;
        rec.etaSeconds = null;
        this.speedHistory.delete(rec.id);
        if (rec.direction === 'send') {
          this.postWorker({ type: 'user-pause', transferId: rec.id, paused: true });
        }
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'resume': {
        const rec = this.transfers.get(msg.id);
        if (!rec || rec.status !== 'paused') return;
        rec.status = 'transferring';
        this.speedHistory.set(rec.id, [
          { t: performance.now(), bytes: rec.bytesTransferred, wireBytes: rec.wireBytesTransferred },
        ]);
        if (rec.direction === 'send') {
          this.postWorker({ type: 'user-pause', transferId: rec.id, paused: false });
        }
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'cancel': {
        this.benchRecvLinks.delete(msg.id);
        const rec = this.transfers.get(msg.id);
        this.postWorker({ type: 'cancel', transferId: msg.id });
        if (!rec) return;
        rec.status = 'cancelled';
        rec.errorMessage = msg.reason;
        rec.throughputMBps = null;
        rec.wireThroughputMBps = null;
        rec.etaSeconds = null;
        rec.completedAt = Date.now();
        this.sourceFiles.delete(msg.id);
        this.speedHistory.delete(msg.id);
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'complete': {
        this.remoteCompletedInfo.set(msg.id, {
          hash: msg.hash,
          sink: msg.sink,
          writeMs: msg.writeMs,
          finalizeMs: msg.finalizeMs,
        });
        this.tryFinalizeSend(msg.id);
        break;
      }
      case 'failed': {
        const bench = this.benchSenders.get(msg.id);
        if (bench) {
          bench.readyReject?.(new Error(msg.reason));
          bench.doneReject?.(new Error(msg.reason));
          this.postWorker({ type: 'cancel', transferId: msg.id });
          return;
        }
        const rec = this.transfers.get(msg.id);
        if (!rec) return;
        rec.status = 'failed';
        rec.errorMessage = msg.reason;
        rec.throughputMBps = null;
        rec.wireThroughputMBps = null;
        rec.etaSeconds = null;
        this.sourceFiles.delete(msg.id);
        this.speedHistory.delete(msg.id);
        this.postWorker({ type: 'cancel', transferId: msg.id });
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'bench-offer': {
        this.benchRecvLinks.set(msg.id, link);
        let resolvedTransport: ActiveTransportKind = msg.transport ?? 'reliable-sctp';
        let turboRxUrl: string | null = null;
        if (resolvedTransport === 'lan-turbo') {
          turboRxUrl =
            (msg.turboInstanceId && this.reachableTurboByInstance.get(msg.turboInstanceId)) || null;
          if (!turboRxUrl) resolvedTransport = 'reliable-sctp';
        }
        this.postWorker({
          type: 'recv-start',
          linkId: link.linkId,
          transferId: msg.id,
          name: `benchmark-${msg.id}.bin`,
          size: msg.sizeBytes ?? Number.POSITIVE_INFINITY,
          compress: msg.compress,
          transport: resolvedTransport,
          turboEndpoint: turboRxUrl,
          localBusToken: resolvedTransport === 'local-bus' ? (msg.localBusToken ?? null) : null,
          saveHandle: null,
          bench: true,
          preferredSink: msg.preferredSink ?? 'discard',
          windowOverride: msg.windowOverride,
          ramArenaBudget: this.deviceProfile.ramArenaBudget,
        });
        break;
      }
      case 'bench-ready': {
        const bench = this.benchSenders.get(msg.id);
        bench?.readyResolve?.({ window: msg.window, sink: msg.sink });
        break;
      }
      case 'bench-stop': {
        this.postWorker({ type: 'bench-stop', transferId: msg.id, bytes: msg.bytes, blast: msg.blast });
        break;
      }
      case 'bench-result': {
        const bench = this.benchSenders.get(msg.id);
        if (bench) {
          bench.remoteResult = msg;
          if (bench.drainedData) bench.doneResolve?.();
        }
        break;
      }
    }
  }

  // ───────────────────────── Worker Bridge & Events ─────────────────────────

  private postWorker(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  private analyzeInWorker(fileId: string, file: File): Promise<{ entropy: number; compress: boolean }> {
    return new Promise((resolve, reject) => {
      this.pendingAnalyses.set(fileId, { resolve, reject });
      this.postWorker({ type: 'analyze', fileId, file });
    });
  }

  private handleWorkerMessage = (event: MessageEvent<FromWorker>): void => {
    const msg = event.data;
    switch (msg.type) {
      case 'ready':
        this.lz4Ready = msg.lz4;
        this.opfsReady = msg.opfs;
        this.opfsSyncReady = msg.opfsSync;
        this.secureContext = msg.secure;
        this.workerReadyResolve();
        void scanSystemHardware(msg.opfsSync).then((hw) => {
          this.selfHw = hw;
          this.broadcastHello();
          this.emitHud();
        });
        this.emitHud();
        break;
      case 'attached':
        break;
      case 'analysis': {
        const waiter = this.pendingAnalyses.get(msg.fileId);
        if (waiter) {
          this.pendingAnalyses.delete(msg.fileId);
          waiter.resolve({ entropy: msg.entropy, compress: msg.compress });
        }
        break;
      }
      case 'tune': {
        const link = this.linkById.get(msg.linkId);
        if (!link) break;
        link.highWatermark = msg.highWatermark;
        link.lowWatermark = msg.lowWatermark;
        for (const p of [link.bridgePool, link.blastBridgePool]) {
          if (!p) continue;
          p.setActiveLanes(msg.lanes);
          p.setActiveChannelsPerLane(msg.channels);
          p.setSchedulePolicy(msg.schedule);
          p.setHighWatermark(msg.highWatermark);
        }
        this.emitHud();
        break;
      }
      case 'frame-out': {
        const link = this.linkById.get(msg.linkId);
        const useBlast = Boolean(msg.blast) && link?.blastBridgePool !== null;
        const pool = useBlast ? link?.blastBridgePool : link?.bridgePool;
        if (!link || !pool) return;
        const t0 = performance.now();
        const ok = pool.send(msg.data);
        link.bridgeHandoffs++;
        if (!ok) {
          const bench = this.benchSenders.get(msg.transferId);
          if (bench) {
            bench.doneReject?.(new Error('Bridge data channels closed mid-benchmark'));
            this.postWorker({ type: 'cancel', transferId: msg.transferId });
            return;
          }
          const rec = this.transfers.get(msg.transferId);
          if (rec) {
            rec.status = 'failed';
            rec.errorMessage = 'Data channels closed mid-stream';
            this.postWorker({ type: 'cancel', transferId: msg.transferId });
            this.emitTransfers();
          }
          return;
        }
        if (useBlast) {
          link.pendingBlastAckBytes += msg.data.byteLength;
          if (!link.blastAckScheduled) {
            link.blastAckScheduled = true;
            queueMicrotask(() => {
              link.blastAckScheduled = false;
              link.bridgeWaitMs += performance.now() - t0;
              if (link.disposed || !link.blastBridgePool) return;
              const bytes = link.pendingBlastAckBytes;
              link.pendingBlastAckBytes = 0;
              this.postWorker({
                type: 'bridge-ack',
                linkId: link.linkId,
                bytes,
                paused: !link.blastBridgePool.canSend,
                blast: true,
              });
              this.syncBridgeStats(link);
            });
          }
        } else {
          link.pendingAckBytes += msg.data.byteLength;
          if (!link.ackScheduled) {
            link.ackScheduled = true;
            queueMicrotask(() => {
              link.ackScheduled = false;
              link.bridgeWaitMs += performance.now() - t0;
              if (link.disposed || !link.bridgePool) return;
              const bytes = link.pendingAckBytes;
              link.pendingAckBytes = 0;
              this.postWorker({
                type: 'bridge-ack',
                linkId: link.linkId,
                bytes,
                paused: !link.bridgePool.canSend,
                blast: false,
              });
              this.syncBridgeStats(link);
            });
          }
        }
        break;
      }
      case 'blast-eof-out': {
        const bench = this.benchSenders.get(msg.transferId);
        if (bench) {
          this.sendControl(bench.link, {
            t: 'eof-blast',
            id: msg.transferId,
            totalBytes: msg.totalBytes,
            senderHash: msg.senderHash,
          });
          return;
        }
        const rec = this.transfers.get(msg.transferId);
        if (!rec) return;
        const link = this.links.get(rec.peerId);
        if (link) {
          this.sendControl(link, {
            t: 'eof-blast',
            id: msg.transferId,
            totalBytes: msg.totalBytes,
            senderHash: msg.senderHash,
          });
        }
        break;
      }
      case 'nack-out': {
        const rec = this.transfers.get(msg.transferId);
        if (rec) {
          const link = this.links.get(rec.peerId);
          if (link) {
            this.sendControl(link, {
              t: 'nack-report',
              id: msg.transferId,
              receivedBlocks: msg.receivedBlocks,
              totalBlocks: msg.totalBlocks,
              ranges: msg.ranges,
              finalAudit: msg.finalAudit,
            });
          }
          return;
        }
        const benchLink = this.benchRecvLinks.get(msg.transferId);
        if (benchLink && benchLink.ctrl.readyState === 'open') {
          this.sendControl(benchLink, {
            t: 'nack-report',
            id: msg.transferId,
            receivedBlocks: msg.receivedBlocks,
            totalBlocks: msg.totalBlocks,
            ranges: msg.ranges,
            finalAudit: msg.finalAudit,
          });
        }
        break;
      }
      case 'send-progress': {
        const bench = this.benchSenders.get(msg.transferId);
        if (bench) {
          bench.link.lastTuner = msg.tuner;
          this.emitHud();
          return;
        }
        const rec = this.transfers.get(msg.transferId);
        if (!rec || rec.status === 'paused' || rec.status === 'cancelled' || rec.status === 'failed') return;
        const link = this.links.get(rec.peerId);
        if (link) link.lastTuner = msg.tuner;
        rec.bytesTransferred = msg.rawBytes;
        rec.wireBytesTransferred = msg.wireBytes;
        rec.transport = msg.tuner.transport;
        rec.retransmittedBlocks = msg.tuner.retransmittedBlocks;
        rec.chunkSize = msg.tuner.chunk;
        rec.activeChannels = msg.tuner.channels ?? CHANNEL_COUNT;
        rec.activeLanes = msg.tuner.lanes;
        this.updateThroughputAndRatio(rec);
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'send-drained': {
        const bench = this.benchSenders.get(msg.transferId);
        if (bench) {
          void (async () => {
            if (bench.link.blastBridgePool) await bench.link.blastBridgePool.flush();
            if (bench.link.bridgePool) await bench.link.bridgePool.flush();
            bench.drainedData = msg;
            this.sendControl(bench.link, {
              t: 'bench-stop',
              id: msg.transferId,
              bytes: msg.rawBytes,
              senderHash: msg.hash,
              blast: msg.finalTuner.transport === 'blast-nack',
            });
            if (bench.remoteResult) bench.doneResolve?.();
          })();
          return;
        }
        const rec = this.transfers.get(msg.transferId);
        if (!rec) return;
        const link = this.links.get(rec.peerId);
        void (async () => {
          if (link?.blastBridgePool) await link.blastBridgePool.flush();
          if (link?.bridgePool) await link.bridgePool.flush();
          rec.bytesTransferred = rec.fileSize;
          rec.retransmittedBlocks = msg.retransmittedBlocks;
          if (rec.status === 'transferring') rec.status = 'flushing';
          this.sendDrainedHashes.set(msg.transferId, msg.hash);
          this.tryFinalizeSend(msg.transferId);
          this.emitTransfers();
        })();
        break;
      }
      case 'recv-ready': {
        if (msg.transferId.startsWith('bench-')) {
          const benchLink = this.benchRecvLinks.get(msg.transferId);
          if (benchLink && benchLink.ctrl.readyState === 'open') {
            benchLink.lastSink = msg.sink;
            this.sendControl(benchLink, { t: 'bench-ready', id: msg.transferId, window: msg.window, sink: msg.sink });
          }
          return;
        }
        const rec = this.transfers.get(msg.transferId);
        if (!rec || rec.direction !== 'receive') return;
        rec.sink = msg.sink;
        const link = this.links.get(rec.peerId);
        if (link && link.ctrl.readyState === 'open') {
          link.lastSink = msg.sink;
          const meta = this.transferTransportMeta.get(msg.transferId);
          this.sendControl(link, {
            t: 'accept',
            id: msg.transferId,
            window: msg.window,
            sink: msg.sink,
            transport: rec.transport,
            turboInstanceId: meta?.turboInstanceId ?? null,
            localBusToken: meta?.localBusToken ?? null,
          });
        }
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'credit-out': {
        const rec = this.transfers.get(msg.transferId);
        if (rec) {
          const link = this.links.get(rec.peerId);
          if (link) this.sendControl(link, { t: 'credit', id: msg.transferId, bytes: msg.bytes });
          return;
        }
        const benchLink = this.benchRecvLinks.get(msg.transferId);
        if (benchLink && benchLink.ctrl.readyState === 'open') {
          this.sendControl(benchLink, { t: 'credit', id: msg.transferId, bytes: msg.bytes });
        }
        break;
      }
      case 'recv-progress': {
        if (msg.transferId.startsWith('bench-')) {
          const benchLink = this.benchRecvLinks.get(msg.transferId);
          if (benchLink) {
            benchLink.receiverPendingBytes = msg.pendingWriteBytes;
            benchLink.lastSink = msg.sink;
          }
          this.emitHud();
          return;
        }
        const rec = this.transfers.get(msg.transferId);
        if (!rec || rec.status === 'paused' || rec.status === 'cancelled' || rec.status === 'failed') return;
        const link = this.links.get(rec.peerId);
        if (link) {
          link.receiverPendingBytes = msg.pendingWriteBytes;
          link.lastSink = msg.sink;
        }
        rec.sink = msg.sink;
        rec.bytesTransferred = msg.rawBytes;
        rec.wireBytesTransferred = msg.wireBytes;
        this.updateThroughputAndRatio(rec);
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'recv-complete': {
        const rec = this.transfers.get(msg.transferId);
        if (!rec) return;
        if (!msg.savedToHandle && msg.file) {
          triggerDownload(msg.file, rec.fileName);
          setTimeout(() => this.postWorker({ type: 'release', transferId: msg.transferId }), 90_000);
        }
        rec.bytesTransferred = rec.fileSize;
        rec.sink = msg.sink;
        rec.finalizeMs = Math.round(msg.finalizeMs);
        rec.integrityVerified = true;
        rec.status = 'completed';
        rec.throughputMBps = null;
        rec.wireThroughputMBps = null;
        rec.etaSeconds = 0;
        rec.completedAt = Date.now();
        this.speedHistory.delete(rec.id);
        const link = this.links.get(rec.peerId);
        if (link) {
          link.receiverPendingBytes = 0;
          if (link.ctrl.readyState === 'open') {
            this.sendControl(link, {
              t: 'complete',
              id: rec.id,
              hash: msg.hash,
              sink: msg.sink,
              writeMs: msg.writeMs,
              finalizeMs: msg.finalizeMs,
            });
          }
        }
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'bench-done': {
        const benchLink = this.benchRecvLinks.get(msg.transferId);
        this.benchRecvLinks.delete(msg.transferId);
        if (benchLink) {
          benchLink.receiverPendingBytes = 0;
          if (benchLink.ctrl.readyState === 'open') {
            this.sendControl(benchLink, {
              t: 'bench-result',
              id: msg.transferId,
              bytes: msg.bytes,
              wireBytes: msg.wireBytes,
              elapsedMs: msg.elapsedMs,
              writeMs: msg.writeMs,
              finalizeMs: msg.finalizeMs,
              maxPendingWriteBytes: msg.maxPendingWriteBytes,
              duplicateBlocks: msg.duplicateBlocks,
              sink: msg.sink,
              hash: msg.hash,
              complete: msg.complete,
            });
          }
        }
        this.emitHud();
        break;
      }
      case 'transfer-error': {
        const analysisWaiter = this.pendingAnalyses.get(msg.transferId);
        if (analysisWaiter) {
          this.pendingAnalyses.delete(msg.transferId);
          analysisWaiter.reject(new Error(msg.message));
          return;
        }
        const bench = this.benchSenders.get(msg.transferId);
        if (bench) {
          bench.readyReject?.(new Error(msg.message));
          bench.doneReject?.(new Error(msg.message));
          return;
        }
        if (msg.transferId.startsWith('bench-')) {
          const benchLink = this.benchRecvLinks.get(msg.transferId);
          this.benchRecvLinks.delete(msg.transferId);
          if (benchLink) {
            this.sendControl(benchLink, { t: 'failed', id: msg.transferId, reason: msg.message });
          }
          return;
        }
        const rec = this.transfers.get(msg.transferId);
        if (!rec) return;
        rec.status = 'failed';
        rec.errorMessage = msg.message;
        rec.throughputMBps = null;
        rec.wireThroughputMBps = null;
        rec.etaSeconds = null;
        this.sourceFiles.delete(rec.id);
        this.speedHistory.delete(rec.id);
        const link = this.links.get(rec.peerId);
        if (link && link.ctrl.readyState === 'open') {
          this.sendControl(link, { t: 'failed', id: rec.id, reason: msg.message });
        }
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'queue': {
        const link = this.linkById.get(msg.linkId);
        if (!link) return;
        link.buffered = msg.buffered;
        link.channelLaneIds = msg.lanes;
        link.activeChannels = msg.active;
        link.highWatermark = msg.highWatermark;
        this.emitHud();
        break;
      }
    }
  };

  private tryFinalizeSend(transferId: string): void {
    const senderHash = this.sendDrainedHashes.get(transferId);
    const remoteInfo = this.remoteCompletedInfo.get(transferId);
    if (senderHash === undefined || !remoteInfo) return;
    this.sendDrainedHashes.delete(transferId);
    this.remoteCompletedInfo.delete(transferId);
    const rec = this.transfers.get(transferId);
    if (!rec) return;
    rec.bytesTransferred = rec.fileSize;
    if (remoteInfo.sink) rec.sink = remoteInfo.sink;
    if (remoteInfo.finalizeMs !== undefined) rec.finalizeMs = Math.round(remoteInfo.finalizeMs);
    rec.integrityVerified = remoteInfo.hash ? remoteInfo.hash === senderHash : true;
    if (rec.integrityVerified === false) {
      rec.status = 'failed';
      rec.errorMessage = 'Integrity hash mismatch after transfer';
    } else {
      rec.status = 'completed';
    }
    rec.throughputMBps = null;
    rec.wireThroughputMBps = null;
    rec.etaSeconds = 0;
    rec.completedAt = Date.now();
    this.sourceFiles.delete(transferId);
    this.speedHistory.delete(transferId);
    this.emitTransfers();
    this.emitHud();
  }

  private updateThroughputAndRatio(rec: TransferRecord): void {
    const now = performance.now();
    const samples = this.speedHistory.get(rec.id) ?? [];
    samples.push({ t: now, bytes: rec.bytesTransferred, wireBytes: rec.wireBytesTransferred });
    const windowStart = now - 1_400;
    while (samples.length > 2 && samples[0].t < windowStart) samples.shift();
    this.speedHistory.set(rec.id, samples);

    if (samples.length >= 2) {
      const first = samples[0];
      const dtSec = (now - first.t) / 1000;
      const dBytes = rec.bytesTransferred - first.bytes;
      const dWire = rec.wireBytesTransferred - first.wireBytes;
      if (dtSec >= 0.08 && dBytes >= 0) {
        const mbps = dBytes / (1024 * 1024) / dtSec;
        const wireMbps = Math.max(0, dWire) / (1024 * 1024) / dtSec;
        rec.throughputMBps = Math.round(mbps * 10) / 10;
        rec.wireThroughputMBps = Math.round(wireMbps * 10) / 10;
        const remainingMB = Math.max(0, rec.fileSize - rec.bytesTransferred) / (1024 * 1024);
        rec.etaSeconds = mbps > 0.05 ? Math.max(1, Math.ceil(remainingMB / mbps)) : null;
      }
    }

    if (rec.wireBytesTransferred > 0 && rec.bytesTransferred > 0) {
      rec.compressionRatio = Math.round((rec.bytesTransferred / rec.wireBytesTransferred) * 100) / 100;
    }
  }

  private syncActiveTransferRoute(link: PeerLink): void {
    const rtt = link.telemetry.rttMs ?? link.pingRttMs;
    for (const rec of this.transfers.values()) {
      if (
        rec.peerId === link.peerId &&
        (rec.status === 'transferring' || rec.status === 'offering' || rec.status === 'offered')
      ) {
        rec.route = link.telemetry.route;
        rec.candidatePairLabel = link.telemetry.candidatePairLabel;
        rec.rttMs = rtt;
      }
    }
  }

  private async sumAllLanesStats(link: PeerLink): Promise<{
    primary: LinkTelemetrySnapshot;
    bytesSent: number;
    bytesReceived: number;
  }> {
    const primary = await link.cascade.refreshTelemetry();
    let bytesSent = primary.bytesSent;
    let bytesReceived = primary.bytesReceived;
    for (const lane of link.extraLanes.values()) {
      if (lane.closed || lane.pc.connectionState !== 'connected') continue;
      const snap = await sampleLinkTelemetry(lane.pc);
      bytesSent += snap.bytesSent;
      bytesReceived += snap.bytesReceived;
    }
    return { primary, bytesSent, bytesReceived };
  }

  private async refreshLinkStats(link: PeerLink): Promise<void> {
    const { primary, bytesSent, bytesReceived } = await this.sumAllLanesStats(link);
    link.telemetry = primary;
    const now = performance.now();
    const totalBytes = bytesSent + bytesReceived;
    if (link.lastStatsSample) {
      const dtSec = (now - link.lastStatsSample.t) / 1000;
      if (dtSec >= 0.15) {
        const delta = Math.max(0, totalBytes - link.lastStatsSample.totalBytes);
        link.statsWireMBps = Math.round((delta / (1024 * 1024) / dtSec) * 10) / 10;
      }
    }
    link.lastStatsSample = { t: now, totalBytes };
  }

  private async tickTelemetry(): Promise<void> {
    for (const link of this.links.values()) {
      if (link.disposed || link.pc.connectionState !== 'connected') continue;
      if (link.ctrl.readyState === 'open') {
        this.sendControl(link, { t: 'ping', ts: performance.now() });
      }
      await this.refreshLinkStats(link);

      if (link.bridgePool) {
        this.syncBridgeStats(link);
      }

      const rtt = link.telemetry.rttMs ?? link.pingRttMs ?? 1;
      const maxSctp = link.pc.sctp?.maxMessageSize ?? MAX_CHUNK + 64;
      this.postWorker({ type: 'net', linkId: link.linkId, rttMs: rtt, maxMessageSize: maxSctp });
      this.syncActiveTransferRoute(link);
      this.callbacks.onPeerLinkState?.(
        link.peerId,
        link.pc.connectionState,
        link.telemetry.route,
        link.telemetry.rttMs ?? link.pingRttMs,
      );
    }
    this.emitHud();
  }

  private emitTransfers(): void {
    this.callbacks.onTransfersChange(this.getTransfers());
  }

  private emitHud(): void {
    const activeList = [...this.transfers.values()].filter(
      (t) => t.status === 'transferring' || t.status === 'flushing',
    );
    const activeTransfer = activeList[0];
    const targetPeerId =
      activeTransfer?.peerId ?? this.focusedPeerId ?? this.links.keys().next().value ?? null;
    const link = targetPeerId ? (this.links.get(targetPeerId) ?? null) : null;
    const rttMs = link ? (link.telemetry.rttMs ?? link.pingRttMs) : null;
    const connectedExtra = link
      ? [...link.extraLanes.values()].filter((l) => !l.closed && l.pc.connectionState === 'connected').length
      : 0;
    const connectedLanes = link && link.pc.connectionState === 'connected' ? 1 + connectedExtra : 0;
    const tuner = link?.lastTuner ?? null;
    const highWm = link?.highWatermark ?? INITIAL_HIGH_WATERMARK;

    const sharedTurbo = this.resolveSharedTurbo(link);
    const localBusReady = Boolean(link?.localBusToken);
    const previewPlan = link
      ? negotiateJointTransferPlan(
          this.deviceProfile,
          link.peerCaps.hw,
          activeTransfer?.fileSize ?? 0,
          link.telemetry.route,
          rttMs,
          this.transportMode,
          Boolean(link.peerCaps.blastNack),
          localBusReady,
          sharedTurbo?.localUrl ?? null,
        )
      : null;

    const appMBps =
      activeTransfer?.throughputMBps ??
      (tuner && this.benchSenders.size > 0 ? Math.round((tuner.drainBps / (1024 * 1024)) * 10) / 10 : 0);

    const hud: TelemetryHUDState = {
      activeLinkPeerId: link?.peerId ?? null,
      peerName: link?.peerName ?? null,
      connectionState: link ? link.pc.connectionState : 'idle',
      route: link?.telemetry.route ?? 'unknown',
      candidatePairLabel: link?.telemetry.candidatePairLabel ?? 'standby',
      protocol: link?.telemetry.protocol ?? null,
      rttMs,
      throughputMBps: appMBps,
      wireThroughputMBps: activeTransfer?.wireThroughputMBps ?? appMBps,
      statsWireMBps: link?.statsWireMBps ?? 0,
      compressionRatio: activeTransfer?.compressionRatio ?? null,
      compressed: activeTransfer?.compressed ?? Boolean(tuner?.lz4),
      transportMode: this.transportMode,
      activeTransport:
        activeTransfer?.transport ?? tuner?.transport ?? previewPlan?.transport ?? 'blast-nack',
      selfHw: this.selfHw,
      peerHw: link?.peerCaps.hw ?? null,
      topologyLabel: previewPlan?.topologyLabel ?? 'Standby Mesh',
      concurrentTransfers: activeList.length,
      chunkSize:
        activeTransfer?.chunkSize ??
        tuner?.chunk ??
        previewPlan?.initialChunk ??
        (link?.pc.sctp?.maxMessageSize ? Math.min(MAX_CHUNK, link.pc.sctp.maxMessageSize) : DEFAULT_CHUNK),
      maxSctpMessageSize: link?.pc.sctp?.maxMessageSize ?? null,
      activeChannels: activeTransfer?.activeChannels ?? link?.activeChannels ?? CHANNEL_COUNT,
      activeLanes: activeTransfer?.activeLanes ?? tuner?.lanes ?? Math.max(1, connectedLanes),
      connectedLanes,
      highWatermark: highWm,
      lowWatermark: link?.lowWatermark ?? lowWatermarkFor(highWm, CHANNEL_COUNT),
      channelBufferedBytes: link?.buffered ?? [0, 0, 0, 0],
      channelLaneIds: link?.channelLaneIds ?? ['0', '0', '0', '0'],
      workerMode: link?.nativeWorkerChannels ? 'native-worker-dc' : 'transferable-bridge',
      sink: activeTransfer?.sink ?? link?.lastSink ?? null,
      receiverPendingBytes: link?.receiverPendingBytes ?? 0,
      tuner,
      lz4Ready: this.lz4Ready,
      opfsReady: this.opfsReady,
      opfsSyncReady: this.opfsSyncReady,
      secureContext: this.secureContext,
      degraded: link?.telemetry.route === 'relay',
      turboAvailable: Boolean(sharedTurbo) || this.reachableTurboByInstance.size > 0,
      localBusAvailable: localBusReady,
      turboEndpoints: this.selfTurboLanUrls,
      peerLanTurboUrl:
        link?.peerCaps.turboEndpoints?.find((u) => !u.includes('127.0.0.1') && !u.includes('localhost')) ??
        null,
    };
    this.callbacks.onTelemetryChange(hud);
  }
}
