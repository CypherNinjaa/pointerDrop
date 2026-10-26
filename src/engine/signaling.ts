import { joinRoom as joinMqttRoom, selfId, type JsonValue, type Room } from '@trystero-p2p/mqtt';
import { joinRoom as joinTorrentRoom } from '@trystero-p2p/torrent';
import { deriveLanSubnetRoomId } from './iceCascade';
import { randomId, type IceRoute } from './protocol';
import type { SignalWirePayload } from './webrtc';

/**
 * 32-symbol unambiguous Crockford-inspired alphabet (excludes 0, O, 1, I).
 * Each character carries exactly 5 bits, allowing Sonic Drop FSK and human-typed
 * Warp Codes (e.g. `A7X-92K`) to share an identical 6-character token space.
 */
export const WARP_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const WARP_CODE_LENGTH = 6;

const APP_ID = 'airdrop-lan-warp-v1';
const LOCAL_BUS_NAME = 'airdrop-lan-warp-local-v1';
const DEVICE_NAME_KEY = 'warp:device-name-custom-v1';
const SESSION_NAME_KEY = 'warp:device-name-session-v1';
const MQTT_RELAY_URLS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

export type DiscoveryChannel = 'local' | 'lan' | 'warp' | 'sonic';
export type DeviceKind = 'desktop' | 'mobile' | 'extension';

export interface PeerPresence {
  id: string;
  name: string;
  deviceKind: DeviceKind;
  platform: string;
  discoveryVia: DiscoveryChannel;
  warpCode: string | null;
  connectionState: RTCPeerConnectionState | 'discovered';
  route: IceRoute;
  rttMs: number | null;
  discoveredAt: number;
  lastSeen: number;
}

interface AnnouncePayload {
  name: string;
  deviceKind: DeviceKind;
  platform: string;
  via: DiscoveryChannel;
  warpCode: string | null;
}

type LocalBusMessage =
  | { kind: 'hello'; from: string; room: string; announce: AnnouncePayload }
  | { kind: 'welcome'; from: string; to: string; room: string; announce: AnnouncePayload }
  | { kind: 'bye'; from: string }
  | { kind: 'rtc'; msgId: string; from: string; fromName: string; to: string; payload: SignalWirePayload };

// ───────────────────────── Warp Code & Deep-Link Helpers ─────────────────────────

export function generateWarpCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(WARP_CODE_LENGTH));
  let out = '';
  for (let i = 0; i < WARP_CODE_LENGTH; i++) {
    out += WARP_ALPHABET[bytes[i] & 31];
  }
  return out;
}

export function normalizeWarpCode(raw: string): string | null {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== WARP_CODE_LENGTH) return null;
  for (let i = 0; i < cleaned.length; i++) {
    if (!WARP_ALPHABET.includes(cleaned[i])) return null;
  }
  return cleaned;
}

export function formatWarpCode(code: string): string {
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length <= 3) return clean;
  return `${clean.slice(0, 3)}-${clean.slice(3, 6)}`;
}

export function buildWarpDeepLink(code: string): string {
  const formatted = formatWarpCode(code);
  if (typeof window === 'undefined') return `#warp=${formatted}`;
  const { protocol, origin, pathname } = window.location;
  if (protocol === 'chrome-extension:') {
    return `https://pointerdrop.app/#warp=${formatted}`;
  }
  return `${origin}${pathname}#warp=${formatted}`;
}

export function extractWarpCodeFromHash(hash = typeof window !== 'undefined' ? window.location.hash : ''): string | null {
  if (!hash) return null;
  const match = hash.match(/(?:^|[#&?])warp=([A-Za-z0-9-]{6,7})(?:&|$)/);
  if (!match?.[1]) return null;
  return normalizeWarpCode(match[1]);
}

// ───────────────────────── Device Identity Helpers ─────────────────────────

export function detectExtensionSidePanel(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.protocol === 'chrome-extension:') {
    const hash = window.location.hash;
    // Full permission helper tab uses #grant=microphone; actual side panel is narrow or default path.
    if (hash.includes('grant=microphone')) return false;
    return true;
  }
  return false;
}

export function detectPlatformLabel(): string {
  if (typeof navigator === 'undefined') return 'Browser';
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const raw = `${uaData?.platform ?? ''} ${navigator.userAgent}`;
  if (/iPhone|iPad|iPod/i.test(raw)) return 'iOS';
  if (/Android/i.test(raw)) return 'Android';
  if (/Mac/i.test(raw)) return 'macOS';
  if (/CrOS/i.test(raw)) return 'ChromeOS';
  if (/Win/i.test(raw)) return 'Windows';
  if (/Linux/i.test(raw)) return 'Linux';
  return 'Web';
}

export function detectDeviceKind(): DeviceKind {
  if (detectExtensionSidePanel()) return 'extension';
  if (typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return 'mobile';
  }
  return 'desktop';
}

export function loadOrCreateDeviceName(): string {
  try {
    const savedCustom = localStorage.getItem(DEVICE_NAME_KEY)?.trim();
    if (savedCustom) return savedCustom.slice(0, 32);
    const savedSession = sessionStorage.getItem(SESSION_NAME_KEY)?.trim();
    if (savedSession) return savedSession.slice(0, 32);
  } catch {
    // Ignore storage block.
  }
  const platform = detectPlatformLabel();
  const kindSuffix = detectExtensionSidePanel() ? 'Sidebar' : 'Node';
  const badge = selfId.slice(0, 3).toUpperCase();
  const generated = `${platform} ${kindSuffix} · ${badge}`;
  try {
    sessionStorage.setItem(SESSION_NAME_KEY, generated);
  } catch {
    // Ignore.
  }
  return generated;
}

export function saveDeviceName(name: string): void {
  const clean = name.trim().slice(0, 32);
  if (!clean) return;
  try {
    localStorage.setItem(DEVICE_NAME_KEY, clean);
  } catch {
    // Ignore.
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({ [DEVICE_NAME_KEY]: clean }).catch(() => {});
  }
}

// ───────────────────────── Room Handle Wrapper ─────────────────────────

interface ManagedRoom {
  roomKey: string;
  via: DiscoveryChannel;
  warpCode: string | null;
  rooms: Room[];
  sendAnnounce: Array<(payload: AnnouncePayload, target?: string) => void>;
  sendRtc: Array<(payload: { msgId: string; fromName: string; signal: SignalWirePayload }, target: string) => void>;
  peerSet: Set<string>;
}

export interface SignalingCallbacks {
  onPeersChange: (peers: PeerPresence[]) => void;
  onPeerDiscovered: (peer: PeerPresence) => void;
  onPeerRemoved: (peerId: string) => void;
  onRtcSignal: (peerId: string, peerName: string, payload: SignalWirePayload) => void;
  onSubnetReady?: (subnetRoomId: string) => void;
  onWarpRoomState?: (code: string | null, status: 'idle' | 'joining' | 'active') => void;
}

/**
 * Multi-transport decentralized discovery & WebRTC signaling coordinator:
 *  1. `BroadcastChannel` for <1 ms local machine / extension-to-tab discovery (works offline).
 *  2. Auto-LAN Subnet Room derived via STUN NAT fingerprint over MQTT + BitTorrent trackers.
 *  3. Ephemeral 6-character Warp Rooms (`#warp-A7X92K`) triggered via Warp Code, URL deep-link,
 *     or Sonic Drop ultrasonic acoustic chirp.
 */
export class SignalingCoordinator {
  readonly selfPeerId = selfId;
  private selfName: string;
  private readonly selfKind: DeviceKind;
  private readonly selfPlatform: string;

  private localBus: BroadcastChannel | null = null;
  private readonly localPeerIds = new Set<string>();
  private lanRoom: ManagedRoom | null = null;
  private warpRoom: ManagedRoom | null = null;
  private activeWarpCode: string | null = null;

  private readonly peers = new Map<string, PeerPresence>();
  private readonly seenSignalIds = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    initialName: string,
    private readonly callbacks: SignalingCallbacks,
  ) {
    this.selfName = initialName;
    this.selfKind = detectDeviceKind();
    this.selfPlatform = detectPlatformLabel();
  }

  async start(): Promise<void> {
    this.setupLocalBus();
    this.announceLocal('lan-local', 'local', null);

    this.heartbeatTimer = setInterval(() => {
      this.broadcastPresenceRefresh();
    }, 8_000);

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.handleBeforeUnload);
    }

    const subnetRoomId = await deriveLanSubnetRoomId();
    if (this.disposed) return;
    this.callbacks.onSubnetReady?.(subnetRoomId);
    this.lanRoom = this.openTrackerRoom(subnetRoomId, 'lan', null);
  }

  setSelfName(name: string): void {
    this.selfName = name.trim().slice(0, 32) || this.selfName;
    saveDeviceName(this.selfName);
    this.broadcastPresenceRefresh();
  }

  getActiveWarpCode(): string | null {
    return this.activeWarpCode;
  }

  getPeers(): PeerPresence[] {
    return [...this.peers.values()].sort((a, b) => a.discoveredAt - b.discoveredAt);
  }

  /** Joins or switches to a 6-character Warp session room (`via`: `'warp'` or `'sonic'`). */
  async joinWarpCode(rawCode: string, via: 'warp' | 'sonic' = 'warp'): Promise<string> {
    const code = normalizeWarpCode(rawCode);
    if (!code) throw new Error('Enter a valid 6-character Warp Code (for example A7X-92K)');

    if (this.activeWarpCode === code && this.warpRoom) {
      if (via === 'sonic') this.warpRoom.via = 'sonic';
      this.broadcastPresenceRefresh();
      return code;
    }

    await this.leaveWarpCode();
    this.activeWarpCode = code;
    this.callbacks.onWarpRoomState?.(code, 'joining');

    const roomKey = `warp-${code}`;
    this.warpRoom = this.openTrackerRoom(roomKey, via, code);
    this.announceLocal(roomKey, via, code);
    this.callbacks.onWarpRoomState?.(code, 'active');
    return code;
  }

  async leaveWarpCode(): Promise<void> {
    const prev = this.warpRoom;
    this.warpRoom = null;
    this.activeWarpCode = null;
    if (prev) {
      await Promise.allSettled(prev.rooms.map((r) => r.leave()));
      // Prune peers only reachable through that warp room.
      for (const peerId of prev.peerSet) {
        if (!this.localPeerIds.has(peerId) && !this.lanRoom?.peerSet.has(peerId)) {
          this.removePeer(peerId);
        }
      }
    }
    this.callbacks.onWarpRoomState?.(null, 'idle');
  }

  updatePeerLinkTelemetry(
    peerId: string,
    connectionState: RTCPeerConnectionState,
    route: IceRoute,
    rttMs: number | null,
  ): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.connectionState = connectionState;
    if (route !== 'unknown') peer.route = route;
    if (rttMs !== null) peer.rttMs = rttMs;
    peer.lastSeen = Date.now();
    this.callbacks.onPeersChange(this.getPeers());
  }

  updatePeerIdentity(peerId: string, name: string, deviceKind: DeviceKind): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (name) peer.name = name;
    peer.deviceKind = deviceKind;
    peer.lastSeen = Date.now();
    this.callbacks.onPeersChange(this.getPeers());
  }

  /** Routes an SDP or ICE signal over the fastest active bus for `peerId`. */
  sendRtcSignal(peerId: string, payload: SignalWirePayload): void {
    const msgId = randomId(6);
    if (this.localBus && this.localPeerIds.has(peerId)) {
      const msg: LocalBusMessage = {
        kind: 'rtc',
        msgId,
        from: this.selfPeerId,
        fromName: this.selfName,
        to: peerId,
        payload,
      };
      this.localBus.postMessage(msg);
      return;
    }

    const envelope = { msgId, fromName: this.selfName, signal: payload };
    if (this.warpRoom?.peerSet.has(peerId)) {
      for (const send of this.warpRoom.sendRtc) send(envelope, peerId);
      return;
    }

    if (this.lanRoom?.peerSet.has(peerId)) {
      for (const send of this.lanRoom.sendRtc) send(envelope, peerId);
      return;
    }

    for (const room of [this.warpRoom, this.lanRoom]) {
      if (!room) continue;
      for (const send of room.sendRtc) send(envelope, peerId);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
    }
    if (this.localBus) {
      try {
        this.localBus.postMessage({ kind: 'bye', from: this.selfPeerId } satisfies LocalBusMessage);
        this.localBus.close();
      } catch {
        // Ignore.
      }
      this.localBus = null;
    }
    const rooms = [...(this.lanRoom?.rooms ?? []), ...(this.warpRoom?.rooms ?? [])];
    this.lanRoom = null;
    this.warpRoom = null;
    await Promise.allSettled(rooms.map((r) => r.leave()));
  }

  // ───────────────────────── Internals ─────────────────────────

  private buildAnnounce(via: DiscoveryChannel, warpCode: string | null): AnnouncePayload {
    return {
      name: this.selfName,
      deviceKind: this.selfKind,
      platform: this.selfPlatform,
      via,
      warpCode,
    };
  }

  private setupLocalBus(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      const bus = new BroadcastChannel(LOCAL_BUS_NAME);
      this.localBus = bus;
      bus.addEventListener('message', (event: MessageEvent<LocalBusMessage>) => {
        const msg = event.data;
        if (!msg || msg.from === this.selfPeerId) return;
        if (msg.kind === 'hello') {
          const matchesLan = msg.room === 'lan-local';
          const matchesWarp = this.activeWarpCode !== null && msg.room === `warp-${this.activeWarpCode}`;
          if (!matchesLan && !matchesWarp) return;
          this.localPeerIds.add(msg.from);
          this.upsertPeer(msg.from, msg.announce);
          const reply: LocalBusMessage = {
            kind: 'welcome',
            from: this.selfPeerId,
            to: msg.from,
            room: msg.room,
            announce: this.buildAnnounce(matchesWarp ? (this.warpRoom?.via ?? 'warp') : 'local', this.activeWarpCode),
          };
          bus.postMessage(reply);
        } else if (msg.kind === 'welcome' && msg.to === this.selfPeerId) {
          this.localPeerIds.add(msg.from);
          this.upsertPeer(msg.from, msg.announce);
        } else if (msg.kind === 'bye') {
          this.localPeerIds.delete(msg.from);
          if (!this.lanRoom?.peerSet.has(msg.from) && !this.warpRoom?.peerSet.has(msg.from)) {
            this.removePeer(msg.from);
          }
        } else if (msg.kind === 'rtc' && msg.to === this.selfPeerId) {
          if (!this.acceptUniqueSignal(msg.msgId)) return;
          this.localPeerIds.add(msg.from);
          this.callbacks.onRtcSignal(msg.from, msg.fromName, msg.payload);
        }
      });
    } catch {
      this.localBus = null;
    }
  }

  private announceLocal(room: string, via: DiscoveryChannel, warpCode: string | null): void {
    if (!this.localBus) return;
    const msg: LocalBusMessage = {
      kind: 'hello',
      from: this.selfPeerId,
      room,
      announce: this.buildAnnounce(via, warpCode),
    };
    this.localBus.postMessage(msg);
  }

  private openTrackerRoom(roomKey: string, via: DiscoveryChannel, warpCode: string | null): ManagedRoom {
    const managed: ManagedRoom = {
      roomKey,
      via,
      warpCode,
      rooms: [],
      sendAnnounce: [],
      sendRtc: [],
      peerSet: new Set(),
    };

    const factories = [
      () =>
        joinMqttRoom(
          { appId: APP_ID, relayConfig: { urls: MQTT_RELAY_URLS, warnOnRelayFailure: false } },
          roomKey,
        ),
      () => joinTorrentRoom({ appId: APP_ID, relayConfig: { warnOnRelayFailure: false } }, roomKey),
    ];

    for (const create of factories) {
      let room: Room;
      try {
        room = create();
      } catch (err) {
        console.warn('[warp] tracker room init skipped', err);
        continue;
      }
      managed.rooms.push(room);

      const announceAction = room.makeAction<Record<string, string | null>>('hello', {
        onMessage: (data, { peerId }) => {
          if (peerId === this.selfPeerId) return;
          managed.peerSet.add(peerId);
          this.upsertPeer(peerId, {
            name: typeof data.name === 'string' && data.name ? data.name : `Peer · ${peerId.slice(0, 3).toUpperCase()}`,
            deviceKind:
              data.deviceKind === 'mobile' || data.deviceKind === 'extension' ? data.deviceKind : 'desktop',
            platform: typeof data.platform === 'string' && data.platform ? data.platform : 'Web',
            via: data.via === 'sonic' || managed.via === 'sonic' ? 'sonic' : managed.via,
            warpCode: managed.warpCode,
          });
        },
      });

      const rtcAction = room.makeAction<Record<string, JsonValue>>('rtc', {
        onMessage: (data, { peerId }) => {
          if (peerId === this.selfPeerId || !data || typeof data !== 'object') return;
          const msgId = typeof data.msgId === 'string' ? data.msgId : null;
          if (msgId && !this.acceptUniqueSignal(msgId)) return;
          managed.peerSet.add(peerId);
          const fromName = typeof data.fromName === 'string' ? data.fromName : 'Peer';
          const signal = data.signal as unknown as SignalWirePayload | undefined;
          if (signal && typeof signal === 'object' && 'kind' in signal) {
            this.callbacks.onRtcSignal(peerId, fromName, signal);
          }
        },
      });

      const sendHello = (payload: AnnouncePayload, target?: string) => {
        if (target && !(target in room.getPeers())) return;
        announceAction
          .send(
            {
              name: payload.name,
              deviceKind: payload.deviceKind,
              platform: payload.platform,
              via: payload.via,
              warpCode: payload.warpCode,
            },
            target ? { target } : undefined,
          )
          .catch(() => {});
      };

      const sendSig = (payload: { msgId: string; fromName: string; signal: SignalWirePayload }, target: string) => {
        if (!(target in room.getPeers())) return;
        rtcAction
          .send(
            {
              msgId: payload.msgId,
              fromName: payload.fromName,
              signal: payload.signal as unknown as JsonValue,
            },
            { target },
          )
          .catch(() => {});
      };

      managed.sendAnnounce.push(sendHello);
      managed.sendRtc.push(sendSig);

      room.onPeerJoin = (peerId) => {
        if (peerId === this.selfPeerId) return;
        managed.peerSet.add(peerId);
        sendHello(this.buildAnnounce(managed.via, managed.warpCode), peerId);
      };

      room.onPeerLeave = (peerId) => {
        // Only evict if none of the room's redundant transports still hold the peer.
        const stillInRoom = managed.rooms.some((r) => peerId in r.getPeers());
        if (!stillInRoom) {
          managed.peerSet.delete(peerId);
          if (
            !this.localPeerIds.has(peerId) &&
            !this.lanRoom?.peerSet.has(peerId) &&
            !this.warpRoom?.peerSet.has(peerId)
          ) {
            this.removePeer(peerId);
          }
        }
      };
    }

    return managed;
  }

  private broadcastPresenceRefresh(): void {
    this.announceLocal('lan-local', 'local', null);
    if (this.activeWarpCode) {
      this.announceLocal(`warp-${this.activeWarpCode}`, this.warpRoom?.via ?? 'warp', this.activeWarpCode);
    }
    if (this.lanRoom) {
      const payload = this.buildAnnounce('lan', null);
      for (const send of this.lanRoom.sendAnnounce) send(payload);
    }
    if (this.warpRoom) {
      const payload = this.buildAnnounce(this.warpRoom.via, this.warpRoom.warpCode);
      for (const send of this.warpRoom.sendAnnounce) send(payload);
    }
  }

  private upsertPeer(peerId: string, announce: AnnouncePayload): void {
    const now = Date.now();
    const existing = this.peers.get(peerId);
    if (existing) {
      existing.name = announce.name || existing.name;
      existing.deviceKind = announce.deviceKind;
      existing.platform = announce.platform || existing.platform;
      if (announce.via === 'sonic') existing.discoveryVia = 'sonic';
      else if (announce.via === 'warp' && existing.discoveryVia !== 'sonic') existing.discoveryVia = 'warp';
      if (announce.warpCode) existing.warpCode = announce.warpCode;
      existing.lastSeen = now;
      this.callbacks.onPeersChange(this.getPeers());
      return;
    }

    const created: PeerPresence = {
      id: peerId,
      name: announce.name,
      deviceKind: announce.deviceKind,
      platform: announce.platform,
      discoveryVia: announce.via,
      warpCode: announce.warpCode,
      connectionState: 'discovered',
      route: 'unknown',
      rttMs: null,
      discoveredAt: now,
      lastSeen: now,
    };
    this.peers.set(peerId, created);
    this.callbacks.onPeerDiscovered(created);
    this.callbacks.onPeersChange(this.getPeers());
  }

  private removePeer(peerId: string): void {
    if (!this.peers.delete(peerId)) return;
    this.callbacks.onPeerRemoved(peerId);
    this.callbacks.onPeersChange(this.getPeers());
  }

  private acceptUniqueSignal(msgId: string): boolean {
    if (this.seenSignalIds.has(msgId)) return false;
    this.seenSignalIds.add(msgId);
    if (this.seenSignalIds.size > 512) {
      const oldest = this.seenSignalIds.values().next().value;
      if (oldest !== undefined) this.seenSignalIds.delete(oldest);
    }
    return true;
  }

  private handleBeforeUnload = (): void => {
    if (this.localBus) {
      try {
        this.localBus.postMessage({ kind: 'bye', from: this.selfPeerId } satisfies LocalBusMessage);
      } catch {
        // Ignore.
      }
    }
  };
}
