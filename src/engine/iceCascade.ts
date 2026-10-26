import type { IceRoute } from './protocol';

/**
 * 3-Tier ICE Cascade & NAT Traversal Adjudicator
 *
 * Tier 1 — `typ host`:  Direct LAN UDP over shared Wi-Fi / Ethernet subnet (< 2 ms).
 * Tier 2 — `typ srflx`: Public STUN reflection + bidirectional UDP hole-punching.
 * Tier 3 — `typ relay`: DTLS-encrypted TURN packet relay for Symmetric CGNAT / strict firewalls.
 */

export const CASCADE_RESTART_DELAY_MS = 800;
const DISCONNECTED_GRACE_MS = 3_200;

export interface TurnCredentials {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const STUN_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/**
 * Default open community TURN relays (end-to-end DTLS-SRTP/SCTP remains encrypted
 * between the two browsers; the relay only forwards opaque UDP/TCP datagrams).
 * Users can override or supplement these in Settings with private TURN servers.
 */
export const DEFAULT_TURN_SERVERS: RTCIceServer[] = [
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
      'turns:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const CUSTOM_TURN_STORAGE_KEY = 'warp:custom-turn-v1';

export function loadCustomTurnServers(): RTCIceServer[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TURN_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RTCIceServer =>
        typeof entry === 'object' &&
        entry !== null &&
        'urls' in entry &&
        (typeof (entry as { urls: unknown }).urls === 'string' || Array.isArray((entry as { urls: unknown }).urls)),
    );
  } catch {
    return [];
  }
}

export function saveCustomTurnServers(servers: RTCIceServer[]): void {
  try {
    if (servers.length === 0) localStorage.removeItem(CUSTOM_TURN_STORAGE_KEY);
    else localStorage.setItem(CUSTOM_TURN_STORAGE_KEY, JSON.stringify(servers));
  } catch {
    // Storage quota or private browsing restriction.
  }
}

export type CascadeStage = 'all' | 'restart' | 'relay-only';

export function buildRtcConfig(stage: CascadeStage = 'all', extraTurn: RTCIceServer[] = []): RTCConfiguration {
  const custom = loadCustomTurnServers();
  const turnPool = [...custom, ...extraTurn, ...DEFAULT_TURN_SERVERS];
  if (stage === 'relay-only') {
    return {
      iceServers: turnPool,
      iceTransportPolicy: 'relay',
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
    };
  }
  return {
    iceServers: [...STUN_SERVERS, ...turnPool],
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 4,
    bundlePolicy: 'max-bundle',
  };
}

export interface LinkTelemetrySnapshot {
  route: IceRoute;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  protocol: string | null;
  rttMs: number | null;
  availableOutgoingBitrate: number | null;
}

function classifyCandidatePair(localType: string | null, remoteType: string | null): IceRoute {
  if (!localType && !remoteType) return 'unknown';
  if (localType === 'relay' || remoteType === 'relay') return 'relay';
  if (localType === 'srflx' || localType === 'prflx' || remoteType === 'srflx' || remoteType === 'prflx') {
    return 'srflx';
  }
  if (localType === 'host' && (!remoteType || remoteType === 'host')) return 'host';
  return 'unknown';
}

/**
 * Queries standard WebRTC `RTCPeerConnection.getStats()` to determine the genuinely
 * active ICE candidate pair, route tier (`host` | `srflx` | `relay`), and live RTT.
 */
export async function sampleLinkTelemetry(pc: RTCPeerConnection): Promise<LinkTelemetrySnapshot> {
  if (pc.connectionState === 'closed') {
    return {
      route: 'unknown',
      localCandidateType: null,
      remoteCandidateType: null,
      protocol: null,
      rttMs: null,
      availableOutgoingBitrate: null,
    };
  }

  const report = await pc.getStats();
  let selectedPairId: string | null = null;
  const pairs: Array<Record<string, unknown>> = [];
  const candidates = new Map<string, Record<string, unknown>>();

  report.forEach((stat: Record<string, unknown>) => {
    if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') {
      selectedPairId = stat.selectedCandidatePairId;
    } else if (stat.type === 'candidate-pair') {
      pairs.push(stat);
    } else if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
      if (typeof stat.id === 'string') candidates.set(stat.id, stat);
    }
  });

  let activePair = selectedPairId ? pairs.find((p) => p.id === selectedPairId) : undefined;
  if (!activePair) {
    activePair =
      pairs.find((p) => p.nominated === true && p.state === 'succeeded') ??
      pairs.find((p) => p.state === 'succeeded');
  }

  if (!activePair) {
    return {
      route: 'unknown',
      localCandidateType: null,
      remoteCandidateType: null,
      protocol: null,
      rttMs: null,
      availableOutgoingBitrate: null,
    };
  }

  const local = typeof activePair.localCandidateId === 'string' ? candidates.get(activePair.localCandidateId) : undefined;
  const remote = typeof activePair.remoteCandidateId === 'string' ? candidates.get(activePair.remoteCandidateId) : undefined;

  const localType = typeof local?.candidateType === 'string' ? local.candidateType : null;
  const remoteType = typeof remote?.candidateType === 'string' ? remote.candidateType : null;
  const protocol = typeof local?.protocol === 'string' ? local.protocol : null;
  const rawRtt = typeof activePair.currentRoundTripTime === 'number' ? activePair.currentRoundTripTime : null;
  const rttMs = rawRtt !== null && Number.isFinite(rawRtt) ? Math.round(rawRtt * 1000 * 10) / 10 : null;
  const availableOutgoingBitrate =
    typeof activePair.availableOutgoingBitrate === 'number' ? activePair.availableOutgoingBitrate : null;

  return {
    route: classifyCandidatePair(localType, remoteType),
    localCandidateType: localType,
    remoteCandidateType: remoteType,
    protocol,
    rttMs,
    availableOutgoingBitrate,
  };
}

export interface IceCascadeCallbacks {
  onRestartIce: () => void;
  onEscalateRelayOnly: () => void;
  onRouteChanged?: (snapshot: LinkTelemetrySnapshot) => void;
}

/**
 * Watches an `RTCPeerConnection` and executes automated self-healing:
 *  1. Initial attempt uses `iceTransportPolicy: 'all'` (Host -> STUN -> TURN).
 *  2. If ICE transitions to `failed` (or stalls in `disconnected`), triggers an
 *     `iceRestart` within 800 ms (roadmap §7).
 *  3. If the restarted session still fails (e.g. strict UDP firewall / Symmetric CGNAT),
 *     escalates to `relay-only` mode over TURN TCP/TLS.
 */
export class IceCascadeMonitor {
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private disposed = false;
  private lastRoute: IceRoute = 'unknown';

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly isInitiator: boolean,
    private readonly callbacks: IceCascadeCallbacks,
  ) {
    this.pc.addEventListener('iceconnectionstatechange', this.handleIceChange);
    this.pc.addEventListener('connectionstatechange', this.handleConnChange);
  }

  async refreshTelemetry(): Promise<LinkTelemetrySnapshot> {
    const snap = await sampleLinkTelemetry(this.pc);
    if (snap.route !== this.lastRoute && snap.route !== 'unknown') {
      this.lastRoute = snap.route;
      this.callbacks.onRouteChanged?.(snap);
    }
    return snap;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.pc.removeEventListener('iceconnectionstatechange', this.handleIceChange);
    this.pc.removeEventListener('connectionstatechange', this.handleConnChange);
  }

  private clearTimers(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.disconnectedTimer !== null) {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
    }
  }

  private scheduleRecovery(): void {
    if (this.disposed || !this.isInitiator || this.restartTimer !== null) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed) return;
      const state = this.pc.iceConnectionState;
      if (state === 'connected' || state === 'completed' || state === 'closed') return;
      this.attempts += 1;
      if (this.attempts === 1) {
        this.callbacks.onRestartIce();
      } else if (this.attempts === 2) {
        this.callbacks.onEscalateRelayOnly();
      }
    }, CASCADE_RESTART_DELAY_MS);
  }

  private handleIceChange = (): void => {
    const state = this.pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      this.clearTimers();
      this.attempts = 0;
      void this.refreshTelemetry();
      return;
    }
    if (state === 'failed') {
      this.scheduleRecovery();
      return;
    }
    if (state === 'disconnected') {
      if (this.disconnectedTimer === null && this.isInitiator) {
        this.disconnectedTimer = setTimeout(() => {
          this.disconnectedTimer = null;
          if (!this.disposed && this.pc.iceConnectionState === 'disconnected') {
            this.scheduleRecovery();
          }
        }, DISCONNECTED_GRACE_MS);
      }
    }
  };

  private handleConnChange = (): void => {
    if (this.pc.connectionState === 'connected') {
      void this.refreshTelemetry();
    } else if (this.pc.connectionState === 'failed') {
      this.scheduleRecovery();
    }
  };
}

/**
 * Derives a privacy-preserving 12-hex-character subnet identifier for Auto-LAN
 * discovery by inspecting the public reflexive address returned by STUN — without
 * calling any external HTTP IP-lookup service and without exposing raw IP addresses
 * on public signaling brokers.
 */
export async function deriveLanSubnetRoomId(): Promise<string> {
  const publicIp = await probeReflexiveAddress(2_400);
  if (!publicIp) return 'lan-local-fallback';
  // Normalize IPv6 to /64 prefix so dual-stack devices on the same router match; keep full IPv4 NAT address.
  const normalized = publicIp.includes(':')
    ? publicIp.split(':').slice(0, 4).join(':').toLowerCase()
    : publicIp.trim();
  const data = new TextEncoder().encode(`airdrop-lan-warp:subnet:v1:${normalized}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest).subarray(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
  return `lan-${hex}`;
}

function probeReflexiveAddress(timeoutMs: number): Promise<string | null> {
  if (typeof RTCPeerConnection === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    const done = (ip: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch {
        // Ignore close error.
      }
      resolve(ip);
    };
    const timer = setTimeout(() => done(null), timeoutMs);

    try {
      pc.createDataChannel('probe');
      pc.addEventListener('icecandidate', (event) => {
        const cand = event.candidate?.candidate;
        if (!cand) {
          if (pc.iceGatheringState === 'complete') done(null);
          return;
        }
        // SDP candidate format: candidate:foundation comp proto priority ip port typ srflx ...
        const match = cand.match(/\b(?:UDP|udp)\s+\d+\s+([^\s]+)\s+\d+\s+typ\s+srflx\b/);
        if (match?.[1]) done(match[1]);
      });
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => done(null));
    } catch {
      done(null);
    }
  });
}
