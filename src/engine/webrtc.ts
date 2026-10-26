import { ChannelPool } from './channelPool';
import { negotiateChunkSize } from './framing';
import {
  buildRtcConfig,
  IceCascadeMonitor,
  type CascadeStage,
  type LinkTelemetrySnapshot,
} from './iceCascade';
import { chooseSaveTarget, hasQuotaFor, triggerDownload } from './opfsDiskStream';
import {
  CHANNEL_COUNT,
  DEGRADED_CHANNELS,
  DEGRADED_CHUNK,
  DEGRADED_RTT_MS,
  DEFAULT_CHUNK,
  MAX_CHUNK,
  MIN_CHUNK,
  randomId,
  type ControlMessage,
  type FileOfferMeta,
  type FromWorker,
  type IceRoute,
  type ToWorker,
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
  status: TransferStatus;
  bytesTransferred: number;
  wireBytesTransferred: number;
  throughputMBps: number | null;
  etaSeconds: number | null;
  compressionRatio: number | null;
  chunkSize: number;
  activeChannels: number;
  route: IceRoute;
  rttMs: number | null;
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
  protocol: string | null;
  rttMs: number | null;
  throughputMBps: number;
  compressionRatio: number | null;
  compressed: boolean;
  chunkSize: number;
  maxSctpMessageSize: number | null;
  activeChannels: number;
  channelBufferedBytes: number[];
  workerMode: 'native-worker-dc' | 'zero-copy-bridge';
  lz4Ready: boolean;
  opfsReady: boolean;
  degraded: boolean;
}

interface SpeedSample {
  t: number;
  bytes: number;
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
  /** Non-null in zero-copy Transferable ArrayBuffer bridge mode; null when channels live inside worker. */
  bridgePool: ChannelPool | null;
  nativeWorkerChannels: boolean;
  cascade: IceCascadeMonitor;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  openWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  telemetry: LinkTelemetrySnapshot;
  pingRttMs: number | null;
  buffered: number[];
  activeChannels: number;
  pendingAckBytes: number;
  ackScheduled: boolean;
  disposed: boolean;
}

export interface WarpEngineCallbacks {
  sendSignal: (peerId: string, payload: SignalWirePayload) => void;
  onTransfersChange: (transfers: TransferRecord[]) => void;
  onTelemetryChange: (hud: TelemetryHUDState) => void;
  onPeerLinkState?: (peerId: string, state: RTCPeerConnectionState, route: IceRoute, rttMs: number | null) => void;
  onRemoteHello?: (peerId: string, name: string, deviceKind: 'desktop' | 'mobile' | 'extension') => void;
}

export class WarpWebRTCEngine {
  private readonly worker: Worker;
  private lz4Ready = false;
  private opfsReady = false;
  private workerReadyResolve!: () => void;
  private readonly workerReadyPromise: Promise<void>;

  private readonly links = new Map<string, PeerLink>();
  private readonly linkById = new Map<string, PeerLink>();
  private readonly transfers = new Map<string, TransferRecord>();
  private readonly sourceFiles = new Map<string, File>();
  private readonly speedHistory = new Map<string, SpeedSample[]>();
  private readonly sendDrainedSet = new Set<string>();
  private readonly remoteCompletedSet = new Set<string>();
  private readonly pendingAnalyses = new Map<
    string,
    { resolve: (v: { entropy: number; compress: boolean }) => void; reject: (e: Error) => void }
  >();

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

    this.telemetryTimer = setInterval(() => {
      void this.tickTelemetry();
    }, 450);
  }

  setSelfName(name: string): void {
    this.selfName = name;
    for (const link of this.links.values()) {
      if (link.ctrl.readyState === 'open') {
        this.sendControl(link, { t: 'hello', name: this.selfName, deviceKind: this.selfDeviceKind });
      }
    }
  }

  setFocusedPeer(peerId: string | null): void {
    this.focusedPeerId = peerId;
    this.emitHud();
  }

  getTransfers(): TransferRecord[] {
    return [...this.transfers.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  /** Pre-warms or awaits the dedicated 5-channel WebRTC transport to `peerId`. */
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

  /** Proactively initiates background handshake when a peer appears on the radar. */
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
      return; // Stale signal from a superseded ICE generation.
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

  /**
   * Wraps a local OS `File` in a zero-copy pointer offer, runs the 64 KB Shannon
   * entropy probe inside the worker, and dispatches the offer to `peerId`.
   */
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
      status: 'analyzing',
      bytesTransferred: 0,
      wireBytesTransferred: 0,
      throughputMBps: null,
      etaSeconds: null,
      compressionRatio: null,
      chunkSize: DEFAULT_CHUNK,
      activeChannels: CHANNEL_COUNT,
      route: 'unknown',
      rttMs: null,
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
      record.route = link.telemetry.route;
      record.rttMs = link.telemetry.rttMs ?? link.pingRttMs;
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

  /** Accepts an incoming file pointer offer (must be called directly from a user click handler). */
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
    if (saveChoice.kind === 'cancelled') {
      // User dismissed the OS file picker — keep the offer pending so they can choose again.
      return;
    }

    const quota = await hasQuotaFor(record.fileSize);
    if (!quota.ok && saveChoice.kind !== 'handle') {
      record.status = 'failed';
      record.errorMessage = 'Insufficient browser disk space for this file';
      this.sendControl(link, { t: 'failed', id: transferId, reason: 'Receiver disk quota exceeded' });
      this.emitTransfers();
      return;
    }

    record.savedVia = saveChoice.kind === 'handle' ? 'filesystem-handle' : 'opfs-download';
    record.status = 'transferring';
    record.startedAt = Date.now();
    this.speedHistory.set(transferId, [{ t: performance.now(), bytes: 0 }]);
    this.emitTransfers();

    this.postWorker({
      type: 'recv-start',
      linkId: link.linkId,
      transferId,
      name: record.fileName,
      size: record.fileSize,
      compress: record.compressed,
      saveHandle: saveChoice.kind === 'handle' ? saveChoice.handle : null,
    });
    this.sendControl(link, { t: 'accept', id: transferId });
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
    this.speedHistory.set(transferId, [{ t: performance.now(), bytes: record.bytesTransferred }]);
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
      if (rec.status === 'completed' || rec.status === 'cancelled' || rec.status === 'declined' || rec.status === 'failed') {
        this.transfers.delete(id);
      }
    }
    this.emitTransfers();
  }

  dispose(): void {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    for (const link of [...this.links.values()]) this.teardownLink(link, null);
    this.worker.terminate();
  }

  // ───────────────────────── Internal: Link Lifecycle ─────────────────────────

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
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      dataChannels.push(
        pc.createDataChannel(`warp-${i}`, {
          negotiated: true,
          id: i + 1,
          ordered: false,
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
      bridgePool: null,
      nativeWorkerChannels: false,
      cascade: new IceCascadeMonitor(pc, startNegotiation || this.isInitiatorFor(peerId), {
        onRestartIce: () => this.performIceRestart(link),
        onEscalateRelayOnly: () => this.escalateToRelayOnly(link),
        onRouteChanged: (snap) => {
          link.telemetry = snap;
          this.syncActiveTransferRoute(link);
          this.callbacks.onPeerLinkState?.(link.peerId, link.pc.connectionState, snap.route, snap.rttMs ?? link.pingRttMs);
          this.emitHud();
        },
      }),
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      pendingCandidates: [],
      openWaiters: [],
      telemetry: {
        route: 'unknown',
        localCandidateType: null,
        remoteCandidateType: null,
        protocol: null,
        rttMs: null,
        availableOutgoingBitrate: null,
      },
      pingRttMs: null,
      buffered: [0, 0, 0, 0],
      activeChannels: CHANNEL_COUNT,
      pendingAckBytes: 0,
      ackScheduled: false,
      disposed: false,
    };

    // Attempt native Worker RTCDataChannel transfer first; gracefully fall back to
    // zero-copy Transferable ArrayBuffer bridge mode when unsupported by the runtime.
    let transferredToWorker = false;
    try {
      this.worker.postMessage(
        { type: 'attach-channels', linkId, channels: dataChannels } satisfies ToWorker,
        dataChannels as unknown as Transferable[],
      );
      transferredToWorker = true;
    } catch {
      transferredToWorker = false;
    }

    if (transferredToWorker) {
      link.nativeWorkerChannels = true;
    } else {
      const pool = new ChannelPool(dataChannels);
      link.bridgePool = pool;
      pool.onValve((open) => {
        this.postWorker({ type: 'flow', linkId, paused: !open });
      });
      for (const ch of dataChannels) {
        ch.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
          const buf = event.data;
          if (buf instanceof ArrayBuffer) {
            this.worker.postMessage({ type: 'chunk-in', linkId, data: buf } satisfies ToWorker, [buf]);
          }
        });
      }
    }

    this.wireControlChannel(link);
    this.wirePeerConnection(link, startNegotiation);

    this.links.set(peerId, link);
    this.linkById.set(linkId, link);
    if (!this.focusedPeerId) this.focusedPeerId = peerId;
    this.emitHud();
    return link;
  }

  private wirePeerConnection(link: PeerLink, startNegotiation: boolean): void {
    const { pc } = link;

    pc.addEventListener('icecandidate', (event) => {
      if (link.disposed || !event.candidate) return;
      this.callbacks.sendSignal(link.peerId, {
        gen: link.gen,
        stage: link.stage,
        kind: 'ice',
        candidate: event.candidate.toJSON(),
      });
    });

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
      this.sendControl(link, { t: 'hello', name: this.selfName, deviceKind: this.selfDeviceKind });
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

    link.cascade.dispose();
    link.bridgePool?.dispose();
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
        this.callbacks.onRemoteHello?.(link.peerId, link.peerName, msg.deviceKind);
        this.emitHud();
        break;
      case 'ping':
        this.sendControl(link, { t: 'pong', ts: msg.ts });
        break;
      case 'pong':
        link.pingRttMs = Math.max(0.1, Math.round((performance.now() - msg.ts) * 10) / 10);
        break;
      case 'offer': {
        this.focusedPeerId = link.peerId;
        const { file } = msg;
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
          status: 'offered',
          bytesTransferred: 0,
          wireBytesTransferred: 0,
          throughputMBps: null,
          etaSeconds: null,
          compressionRatio: null,
          chunkSize: DEFAULT_CHUNK,
          activeChannels: CHANNEL_COUNT,
          route: link.telemetry.route,
          rttMs: link.telemetry.rttMs ?? link.pingRttMs,
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
        const maxSctp = link.pc.sctp?.maxMessageSize ?? DEFAULT_CHUNK + 1024;
        const chunkSize = negotiateChunkSize(maxSctp, rec.compressed, MAX_CHUNK, MIN_CHUNK);
        rec.chunkSize = chunkSize;
        rec.status = 'transferring';
        rec.startedAt = Date.now();
        this.speedHistory.set(rec.id, [{ t: performance.now(), bytes: 0 }]);
        this.postWorker({
          type: 'send-start',
          linkId: link.linkId,
          transferId: rec.id,
          file,
          compress: rec.compressed,
          chunkSize,
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
        this.speedHistory.set(rec.id, [{ t: performance.now(), bytes: rec.bytesTransferred }]);
        if (rec.direction === 'send') {
          this.postWorker({ type: 'user-pause', transferId: rec.id, paused: false });
        }
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'cancel': {
        const rec = this.transfers.get(msg.id);
        if (!rec) return;
        rec.status = 'cancelled';
        rec.errorMessage = msg.reason;
        rec.throughputMBps = null;
        rec.etaSeconds = null;
        rec.completedAt = Date.now();
        this.sourceFiles.delete(msg.id);
        this.speedHistory.delete(msg.id);
        this.postWorker({ type: 'cancel', transferId: msg.id });
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'complete': {
        this.remoteCompletedSet.add(msg.id);
        this.tryFinalizeSend(msg.id);
        break;
      }
      case 'failed': {
        const rec = this.transfers.get(msg.id);
        if (!rec) return;
        rec.status = 'failed';
        rec.errorMessage = msg.reason;
        rec.throughputMBps = null;
        rec.etaSeconds = null;
        this.sourceFiles.delete(msg.id);
        this.speedHistory.delete(msg.id);
        this.postWorker({ type: 'cancel', transferId: msg.id });
        this.emitTransfers();
        this.emitHud();
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
        this.workerReadyResolve();
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
      case 'frame-out': {
        const link = this.linkById.get(msg.linkId);
        if (!link || !link.bridgePool) return;
        const rtt = link.telemetry.rttMs ?? link.pingRttMs ?? 0;
        link.bridgePool.setActiveCount(rtt > DEGRADED_RTT_MS ? DEGRADED_CHANNELS : CHANNEL_COUNT);
        const ok = link.bridgePool.send(msg.data);
        if (!ok) {
          const rec = this.transfers.get(msg.transferId);
          if (rec) {
            rec.status = 'failed';
            rec.errorMessage = 'Data channels closed mid-stream';
            this.postWorker({ type: 'cancel', transferId: msg.transferId });
            this.emitTransfers();
          }
          return;
        }
        link.pendingAckBytes += msg.data.byteLength;
        if (!link.ackScheduled) {
          link.ackScheduled = true;
          queueMicrotask(() => {
            link.ackScheduled = false;
            if (link.disposed || !link.bridgePool) return;
            const bytes = link.pendingAckBytes;
            link.pendingAckBytes = 0;
            this.postWorker({
              type: 'bridge-ack',
              linkId: link.linkId,
              bytes,
              paused: !link.bridgePool.canSend,
            });
          });
        }
        break;
      }
      case 'send-progress': {
        const rec = this.transfers.get(msg.transferId);
        if (!rec || rec.status === 'paused' || rec.status === 'cancelled' || rec.status === 'failed') return;
        rec.bytesTransferred = msg.rawBytes;
        rec.wireBytesTransferred = msg.wireBytes;
        rec.chunkSize = msg.chunkSize;
        rec.activeChannels = msg.channels;
        this.updateThroughputAndRatio(rec);
        this.emitTransfers();
        this.emitHud();
        break;
      }
      case 'send-drained': {
        const rec = this.transfers.get(msg.transferId);
        if (!rec) return;
        const link = this.links.get(rec.peerId);
        void (async () => {
          if (link?.bridgePool) await link.bridgePool.flush();
          rec.bytesTransferred = rec.fileSize;
          if (rec.status === 'transferring') rec.status = 'flushing';
          this.sendDrainedSet.add(msg.transferId);
          this.tryFinalizeSend(msg.transferId);
          this.emitTransfers();
        })();
        break;
      }
      case 'recv-progress': {
        const rec = this.transfers.get(msg.transferId);
        if (!rec || rec.status === 'paused' || rec.status === 'cancelled' || rec.status === 'failed') return;
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
          // Release OPFS staging file after the browser has latched onto the blob download.
          setTimeout(() => this.postWorker({ type: 'release', transferId: msg.transferId }), 90_000);
        }
        rec.bytesTransferred = rec.fileSize;
        rec.status = 'completed';
        rec.throughputMBps = null;
        rec.etaSeconds = 0;
        rec.completedAt = Date.now();
        this.speedHistory.delete(rec.id);
        const link = this.links.get(rec.peerId);
        if (link && link.ctrl.readyState === 'open') {
          this.sendControl(link, { t: 'complete', id: rec.id });
        }
        this.emitTransfers();
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
        const rec = this.transfers.get(msg.transferId);
        if (!rec) return;
        rec.status = 'failed';
        rec.errorMessage = msg.message;
        rec.throughputMBps = null;
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
        link.activeChannels = msg.active;
        this.emitHud();
        break;
      }
    }
  };

  private tryFinalizeSend(transferId: string): void {
    if (!this.sendDrainedSet.has(transferId) || !this.remoteCompletedSet.has(transferId)) return;
    this.sendDrainedSet.delete(transferId);
    this.remoteCompletedSet.delete(transferId);
    const rec = this.transfers.get(transferId);
    if (!rec) return;
    rec.bytesTransferred = rec.fileSize;
    rec.status = 'completed';
    rec.throughputMBps = null;
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
    samples.push({ t: now, bytes: rec.bytesTransferred });
    const windowStart = now - 1_400;
    while (samples.length > 2 && samples[0].t < windowStart) samples.shift();
    this.speedHistory.set(rec.id, samples);

    if (samples.length >= 2) {
      const first = samples[0];
      const dtSec = (now - first.t) / 1000;
      const dBytes = rec.bytesTransferred - first.bytes;
      if (dtSec >= 0.08 && dBytes >= 0) {
        const mbps = dBytes / (1024 * 1024) / dtSec;
        rec.throughputMBps = Math.round(mbps * 10) / 10;
        const remainingMB = Math.max(0, rec.fileSize - rec.bytesTransferred) / (1024 * 1024);
        rec.etaSeconds = mbps > 0.05 ? Math.max(1, Math.ceil(remainingMB / mbps)) : null;
      }
    }

    if (rec.compressed && rec.wireBytesTransferred > 0 && rec.bytesTransferred > 0) {
      rec.compressionRatio = Math.round((rec.bytesTransferred / rec.wireBytesTransferred) * 100) / 100;
    }
  }

  private syncActiveTransferRoute(link: PeerLink): void {
    const rtt = link.telemetry.rttMs ?? link.pingRttMs;
    for (const rec of this.transfers.values()) {
      if (rec.peerId === link.peerId && (rec.status === 'transferring' || rec.status === 'offering' || rec.status === 'offered')) {
        rec.route = link.telemetry.route;
        rec.rttMs = rtt;
      }
    }
  }

  private async tickTelemetry(): Promise<void> {
    for (const link of this.links.values()) {
      if (link.disposed || link.pc.connectionState !== 'connected') continue;
      if (link.ctrl.readyState === 'open') {
        this.sendControl(link, { t: 'ping', ts: performance.now() });
      }
      const snap = await link.cascade.refreshTelemetry();
      link.telemetry = snap;
      if (link.bridgePool) {
        link.buffered = link.bridgePool.bufferedAmounts;
        link.activeChannels = link.bridgePool.activeCount;
      }
      const rtt = snap.rttMs ?? link.pingRttMs ?? 0;
      const maxSctp = link.pc.sctp?.maxMessageSize ?? DEFAULT_CHUNK + 1024;
      const activeSend = [...this.transfers.values()].find(
        (t) => t.peerId === link.peerId && t.direction === 'send' && t.status === 'transferring',
      );
      const baseChunk = negotiateChunkSize(maxSctp, activeSend?.compressed ?? false, MAX_CHUNK, MIN_CHUNK);
      const effectiveChunk = rtt > DEGRADED_RTT_MS ? Math.min(baseChunk, DEGRADED_CHUNK) : baseChunk;
      if (link.bridgePool) {
        link.bridgePool.setActiveCount(rtt > DEGRADED_RTT_MS ? DEGRADED_CHANNELS : CHANNEL_COUNT);
      }
      this.postWorker({ type: 'net', linkId: link.linkId, rttMs: rtt, chunkSize: effectiveChunk });
      this.syncActiveTransferRoute(link);
      this.callbacks.onPeerLinkState?.(link.peerId, link.pc.connectionState, snap.route, snap.rttMs ?? link.pingRttMs);
    }
    this.emitHud();
  }

  private emitTransfers(): void {
    this.callbacks.onTransfersChange(this.getTransfers());
  }

  private emitHud(): void {
    const activeTransfer = [...this.transfers.values()].find(
      (t) => t.status === 'transferring' || t.status === 'flushing',
    );
    const targetPeerId = activeTransfer?.peerId ?? this.focusedPeerId ?? this.links.keys().next().value ?? null;
    const link = targetPeerId ? this.links.get(targetPeerId) ?? null : null;
    const rttMs = link ? (link.telemetry.rttMs ?? link.pingRttMs) : null;

    const hud: TelemetryHUDState = {
      activeLinkPeerId: link?.peerId ?? null,
      peerName: link?.peerName ?? null,
      connectionState: link ? link.pc.connectionState : 'idle',
      route: link?.telemetry.route ?? 'unknown',
      protocol: link?.telemetry.protocol ?? null,
      rttMs,
      throughputMBps: activeTransfer?.throughputMBps ?? 0,
      compressionRatio: activeTransfer?.compressionRatio ?? null,
      compressed: activeTransfer?.compressed ?? false,
      chunkSize: activeTransfer?.chunkSize ?? (link?.pc.sctp?.maxMessageSize ? Math.min(MAX_CHUNK, link.pc.sctp.maxMessageSize) : DEFAULT_CHUNK),
      maxSctpMessageSize: link?.pc.sctp?.maxMessageSize ?? null,
      activeChannels: activeTransfer?.activeChannels ?? link?.activeChannels ?? CHANNEL_COUNT,
      channelBufferedBytes: link?.buffered ?? [0, 0, 0, 0],
      workerMode: link?.nativeWorkerChannels ? 'native-worker-dc' : 'zero-copy-bridge',
      lz4Ready: this.lz4Ready,
      opfsReady: this.opfsReady,
      degraded: rttMs !== null && rttMs > DEGRADED_RTT_MS,
    };
    this.callbacks.onTelemetryChange(hud);
  }
}
