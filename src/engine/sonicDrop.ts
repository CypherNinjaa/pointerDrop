import { normalizeWarpCode, WARP_ALPHABET, WARP_CODE_LENGTH } from './signaling';

/**
 * Sonic Drop — Near-Ultrasonic Acoustic Pairing (18.5 kHz – 19.5 kHz 16-FSK)
 *
 * Frame layout (12 symbols × 70 ms = 840 ms burst):
 *   • Preamble (3 symbols): [0, 15, 7] -> [18 500 Hz, 19 475 Hz, 18 955 Hz]
 *   • Payload  (9 symbols): 36 bits = 30-bit Warp Code (6 × 5-bit symbols) + 6-bit CRC
 *
 * Tone grid:
 *   f(k) = 18 500 Hz + k × 65 Hz   for k ∈ [0, 15]   (18 500 Hz .. 19 475 Hz)
 */

export const SONIC_BASE_HZ = 18_500;
export const SONIC_STEP_HZ = 65;
export const SONIC_TONE_COUNT = 16;
export const SONIC_SYMBOL_MS = 70;
export const SONIC_PREAMBLE: readonly number[] = [0, 15, 7];
export const SONIC_DATA_SYMBOLS = 9;
export const SONIC_TOTAL_SYMBOLS = SONIC_PREAMBLE.length + SONIC_DATA_SYMBOLS; // 12 symbols = 840 ms

const RAMP_SEC = 0.006;
const HOP_MS = 10;
const HOPS_PER_SYMBOL = Math.round(SONIC_SYMBOL_MS / HOP_MS); // 7 hops
const SNR_THRESHOLD_DB = 8.5;

export function toneFrequency(symbol: number): number {
  return SONIC_BASE_HZ + symbol * SONIC_STEP_HZ;
}

/** CRC-6-ITU (x^6 + x + 1, poly 0x03) over a 30-bit integer. */
export function crc6(value30: bigint): number {
  let crc = 0x3f;
  for (let i = 29; i >= 0; i--) {
    const bit = Number((value30 >> BigInt(i)) & 1n);
    const msb = (crc >> 5) & 1;
    crc = ((crc << 1) & 0x3f) ^ (msb ^ bit ? 0x03 : 0);
  }
  return crc & 0x3f;
}

export function encodeTokenToSymbols(rawCode: string): number[] {
  const code = normalizeWarpCode(rawCode);
  if (!code) throw new Error(`Invalid Warp Code for Sonic Drop: ${rawCode}`);

  let bits = 0n;
  for (let i = 0; i < WARP_CODE_LENGTH; i++) {
    const idx = WARP_ALPHABET.indexOf(code[i]);
    bits = (bits << 5n) | BigInt(idx);
  }
  const check = crc6(bits);
  const packet = (bits << 6n) | BigInt(check); // 36 bits

  const dataSymbols: number[] = [];
  for (let j = 0; j < SONIC_DATA_SYMBOLS; j++) {
    const shift = BigInt((SONIC_DATA_SYMBOLS - 1 - j) * 4);
    dataSymbols.push(Number((packet >> shift) & 0xfn));
  }
  return [...SONIC_PREAMBLE, ...dataSymbols];
}

export function decodeSymbolsToToken(symbols: readonly number[]): string | null {
  if (symbols.length !== SONIC_TOTAL_SYMBOLS) return null;
  for (let i = 0; i < SONIC_PREAMBLE.length; i++) {
    if (symbols[i] !== SONIC_PREAMBLE[i]) return null;
  }

  let packet = 0n;
  for (let j = 0; j < SONIC_DATA_SYMBOLS; j++) {
    const sym = symbols[SONIC_PREAMBLE.length + j];
    if (sym < 0 || sym >= SONIC_TONE_COUNT) return null;
    packet = (packet << 4n) | BigInt(sym);
  }

  const receivedCrc = Number(packet & 0x3fn);
  const bits = packet >> 6n;
  if (crc6(bits) !== receivedCrc) return null;

  let out = '';
  for (let i = WARP_CODE_LENGTH - 1; i >= 0; i--) {
    const idx = Number((bits >> BigInt(i * 5)) & 31n);
    out += WARP_ALPHABET[idx];
  }
  return out;
}

// ───────────────────────── Acoustic Transmitter ─────────────────────────

export interface ChirpHandle {
  stop: () => void;
  finished: Promise<void>;
}

/**
 * Modulates `warpCode` into an 840 ms 18.5–19.5 kHz FSK acoustic burst using
 * `OscillatorNode` + click-free `GainNode` envelope shaping.
 */
export function emitSonicChirp(warpCode: string, repeatCount = 2): ChirpHandle {
  const symbols = encodeTokenToSymbols(warpCode);
  const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) throw new Error('Web Audio API is not supported in this browser');

  const ctx = new AudioCtx({ sampleRate: 48_000 });
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  gain.gain.value = 0;
  osc.connect(gain);
  gain.connect(ctx.destination);

  const symSec = SONIC_SYMBOL_MS / 1000;
  const gapSec = 0.22;
  const startAt = ctx.currentTime + 0.04;
  let cursor = startAt;

  for (let rep = 0; rep < repeatCount; rep++) {
    const burstStart = cursor;
    const burstEnd = burstStart + symbols.length * symSec;
    gain.gain.setValueAtTime(0.0001, burstStart);
    gain.gain.linearRampToValueAtTime(0.45, burstStart + RAMP_SEC);
    for (let i = 0; i < symbols.length; i++) {
      const t = burstStart + i * symSec;
      osc.frequency.setValueAtTime(toneFrequency(symbols[i]), t);
    }
    gain.gain.setValueAtTime(0.45, burstEnd - RAMP_SEC);
    gain.gain.linearRampToValueAtTime(0.0001, burstEnd);
    cursor = burstEnd + gapSec;
  }

  let closed = false;
  let resolveDone!: () => void;
  const finished = new Promise<void>((res) => {
    resolveDone = res;
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      osc.stop();
    } catch {
      // Already stopped.
    }
    osc.disconnect();
    gain.disconnect();
    void ctx.close().catch(() => {});
    resolveDone();
  };

  void ctx.resume().catch(() => {});
  osc.start(startAt);
  osc.stop(cursor);
  osc.onended = cleanup;

  return {
    stop: cleanup,
    finished,
  };
}

// ───────────────────────── Acoustic FFT Demodulator ─────────────────────────

export type SonicReceiverErrorKind = 'permission-denied' | 'unsupported' | 'hardware-error';

export interface SonicSpectrumFrame {
  /** Normalized 0..1 energy across the 16 FSK tone slots (18.5–19.5 kHz). */
  bins: number[];
  snrDb: number;
  peakSymbol: number | null;
}

export interface SonicReceiverCallbacks {
  onDecoded: (warpCode: string) => void;
  onSpectrum?: (frame: SonicSpectrumFrame) => void;
  onError: (kind: SonicReceiverErrorKind, message: string) => void;
}

interface HopObservation {
  symbol: number | null;
  snrDb: number;
  toneEnergies: Float32Array;
}

export class SonicDropReceiver {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private fftBuffer: Float32Array<ArrayBuffer> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private history: HopObservation[] = [];
  private active = false;
  private lastDecodedAt = 0;

  constructor(private readonly callbacks: SonicReceiverCallbacks) {}

  get isListening(): boolean {
    return this.active;
  }

  async start(): Promise<boolean> {
    if (this.active) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.callbacks.onError('unsupported', 'Microphone capture is not available in this browser');
      return false;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (error) {
      const isDenied =
        error instanceof DOMException &&
        (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError' || error.name === 'SecurityError');
      this.callbacks.onError(
        isDenied ? 'permission-denied' : 'hardware-error',
        isDenied
          ? 'Microphone permission was denied — switched to 6-character Warp Code entry.'
          : `Could not open microphone: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      this.stop();
      this.callbacks.onError('unsupported', 'Web Audio API is unavailable');
      return false;
    }

    const ctx = new AudioCtx({ sampleRate: 48_000 });
    await ctx.resume().catch(() => {});

    // Verify Nyquist covers 19.5 kHz.
    if (ctx.sampleRate < 40_000) {
      this.stop();
      this.callbacks.onError(
        'hardware-error',
        `Audio device sample rate (${ctx.sampleRate} Hz) is too low for 19.5 kHz ultrasonic reception`,
      );
      return false;
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;

    const source = ctx.createMediaStreamSource(this.stream);
    source.connect(analyser);

    this.ctx = ctx;
    this.source = source;
    this.analyser = analyser;
    this.fftBuffer = new Float32Array(new ArrayBuffer(analyser.frequencyBinCount * 4));
    this.history = [];
    this.active = true;

    this.timer = setInterval(() => this.sampleHop(), HOP_MS);
    return true;
  }

  stop(): void {
    this.active = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.source?.disconnect();
    } catch {
      // Ignore.
    }
    this.source = null;
    this.analyser = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.history = [];
  }

  private sampleHop(): void {
    if (!this.active || !this.analyser || !this.ctx || !this.fftBuffer) return;
    this.analyser.getFloatFrequencyData(this.fftBuffer);

    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const toneDb = new Float32Array(SONIC_TONE_COUNT);

    for (let k = 0; k < SONIC_TONE_COUNT; k++) {
      const targetBin = toneFrequency(k) / binHz;
      const center = Math.round(targetBin);
      // Sample the 3-bin neighborhood around each tone center for sub-bin robustness.
      const left = this.fftBuffer[Math.max(0, center - 1)] ?? -140;
      const mid = this.fftBuffer[center] ?? -140;
      const right = this.fftBuffer[Math.min(this.fftBuffer.length - 1, center + 1)] ?? -140;
      toneDb[k] = Math.max(left, mid, right);
    }

    // Compute median noise floor across the 16 ultrasonic tone slots.
    const sorted = Array.from(toneDb).sort((a, b) => a - b);
    const noiseFloorDb = sorted[Math.floor(sorted.length / 2)];

    let bestIdx = 0;
    let bestDb = -Infinity;
    for (let k = 0; k < SONIC_TONE_COUNT; k++) {
      if (toneDb[k] > bestDb) {
        bestDb = toneDb[k];
        bestIdx = k;
      }
    }

    const snrDb = Math.max(0, bestDb - noiseFloorDb);
    const detectedSymbol = snrDb >= SNR_THRESHOLD_DB ? bestIdx : null;

    if (this.callbacks.onSpectrum) {
      const bins = Array.from(toneDb, (db) => {
        const rel = Math.max(0, Math.min(28, db - noiseFloorDb));
        return Math.round((rel / 28) * 100) / 100;
      });
      this.callbacks.onSpectrum({ bins, snrDb: Math.round(snrDb * 10) / 10, peakSymbol: detectedSymbol });
    }

    this.history.push({ symbol: detectedSymbol, snrDb, toneEnergies: toneDb });
    const requiredHops = SONIC_TOTAL_SYMBOLS * HOPS_PER_SYMBOL + 4;
    if (this.history.length > requiredHops + 20) {
      this.history.splice(0, this.history.length - requiredHops);
    }
    if (this.history.length < requiredHops) return;

    // Avoid firing duplicate decodes during the same burst.
    if (performance.now() - this.lastDecodedAt < 900) return;

    const base = this.history.length - SONIC_TOTAL_SYMBOLS * HOPS_PER_SYMBOL;
    const candidateSymbols: number[] = [];
    for (let s = 0; s < SONIC_TOTAL_SYMBOLS; s++) {
      const centerHop = base + s * HOPS_PER_SYMBOL + Math.floor(HOPS_PER_SYMBOL / 2);
      const sym = this.voteSymbolAt(centerHop);
      if (sym === null) return;
      candidateSymbols.push(sym);
    }

    const decoded = decodeSymbolsToToken(candidateSymbols);
    if (decoded) {
      this.lastDecodedAt = performance.now();
      this.history = [];
      this.callbacks.onDecoded(decoded);
    }
  }

  /** Integrates tone power over the center 3 hops of a 7-hop symbol slot. */
  private voteSymbolAt(centerHop: number): number | null {
    const accum = new Float32Array(SONIC_TONE_COUNT);
    let activeCount = 0;
    for (let delta = -1; delta <= 1; delta++) {
      const obs = this.history[centerHop + delta];
      if (!obs) continue;
      if (obs.snrDb >= SNR_THRESHOLD_DB * 0.85) activeCount++;
      for (let k = 0; k < SONIC_TONE_COUNT; k++) {
        // Sum linear power rather than dB so transient fades don't skew votes.
        accum[k] += Math.pow(10, obs.toneEnergies[k] / 10);
      }
    }
    if (activeCount === 0) return null;
    let bestK = 0;
    let bestPower = -1;
    for (let k = 0; k < SONIC_TONE_COUNT; k++) {
      if (accum[k] > bestPower) {
        bestPower = accum[k];
        bestK = k;
      }
    }
    return bestK;
  }
}
