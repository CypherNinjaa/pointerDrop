import React, { useEffect, useId, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  buildWarpDeepLink,
  formatWarpCode,
  generateWarpCode,
  normalizeWarpCode,
} from '../engine/signaling';
import {
  emitSonicChirp,
  SonicDropReceiver,
  type ChirpHandle,
  type SonicSpectrumFrame,
} from '../engine/sonicDrop';
import { GlassCard } from './GlassCard';

export interface PairingSheetProps {
  activeWarpCode: string | null;
  isExtensionSidePanel: boolean;
  compact: boolean;
  onJoinWarpCode: (code: string, via: 'warp' | 'sonic') => Promise<string>;
  onLeaveWarpCode: () => Promise<void>;
  onClose?: () => void;
}

export const PairingSheet: React.FC<PairingSheetProps> = ({
  activeWarpCode,
  isExtensionSidePanel,
  compact,
  onJoinWarpCode,
  onLeaveWarpCode,
  onClose,
}) => {
  const inputId = useId();
  const errorId = useId();
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const chirpRef = useRef<ChirpHandle | null>(null);
  const receiverRef = useRef<SonicDropReceiver | null>(null);

  const [tab, setTab] = useState<'warp' | 'sonic'>('warp');
  const [hostCode, setHostCode] = useState<string>(() => activeWarpCode ?? generateWarpCode());
  const [joinInput, setJoinInput] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const [isChirping, setIsChirping] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [sonicNotice, setSonicNotice] = useState<string | null>(null);
  const [micDenied, setMicDenied] = useState(false);
  const [spectrum, setSpectrum] = useState<SonicSpectrumFrame>({
    bins: new Array(16).fill(0),
    snrDb: 0,
    peakSymbol: null,
  });

  useEffect(() => {
    if (activeWarpCode) setHostCode(activeWarpCode);
  }, [activeWarpCode]);

  const effectiveCode = activeWarpCode ?? hostCode;
  const deepLink = buildWarpDeepLink(effectiveCode);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(deepLink, {
      width: 156,
      margin: 1,
      color: { dark: '#FFFFFF', light: '#00000000' },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [deepLink]);

  useEffect(() => {
    return () => {
      chirpRef.current?.stop();
      receiverRef.current?.stop();
    };
  }, []);

  const ensureHostingRoom = async (): Promise<string> => {
    const code = await onJoinWarpCode(effectiveCode, 'warp');
    setHostCode(code);
    return code;
  };

  const handleCopy = async (kind: 'code' | 'link') => {
    const code = await ensureHostingRoom();
    const text = kind === 'code' ? formatWarpCode(code) : buildWarpDeepLink(code);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1800);
    } catch {
      // Clipboard blocked.
    }
  };

  const handleManualJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeWarpCode(joinInput);
    if (!normalized) {
      setJoinError('Enter 6 characters using letters A–Z and digits 2–9 (for example A7X-92K).');
      return;
    }
    setJoinError(null);
    try {
      await onJoinWarpCode(normalized, 'warp');
      setJoinInput('');
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleEmitSonic = async () => {
    if (isChirping) {
      chirpRef.current?.stop();
      setIsChirping(false);
      return;
    }
    try {
      const code = await ensureHostingRoom();
      setSonicNotice(null);
      setIsChirping(true);
      const handle = emitSonicChirp(code, 3);
      chirpRef.current = handle;
      await handle.finished;
    } catch (err) {
      setSonicNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setIsChirping(false);
    }
  };

  const handleToggleListen = async () => {
    if (isListening) {
      receiverRef.current?.stop();
      receiverRef.current = null;
      setIsListening(false);
      return;
    }

    setSonicNotice(null);
    setMicDenied(false);
    const receiver = new SonicDropReceiver({
      onSpectrum: (frame) => setSpectrum(frame),
      onDecoded: (decodedCode) => {
        receiver.stop();
        receiverRef.current = null;
        setIsListening(false);
        setSonicNotice(`Acoustic chirp decoded: ${formatWarpCode(decodedCode)} — connected.`);
        void onJoinWarpCode(decodedCode, 'sonic');
      },
      onError: (kind, message) => {
        setIsListening(false);
        setSonicNotice(message);
        if (kind === 'permission-denied') {
          setMicDenied(true);
          // Per roadmap §7: automatically switch to 6-character Warp Code input on mic denial.
          setTab('warp');
          setTimeout(() => codeInputRef.current?.focus(), 60);
        }
      },
    });
    receiverRef.current = receiver;
    const started = await receiver.start();
    if (started) setIsListening(true);
  };

  const openExtensionMicGrantTab = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'warp:open-permission-tab' }).catch(() => {});
    }
  };

  return (
    <GlassCard as="section" aria-label="Cross-network session pairing" padding={compact ? 'sm' : 'md'}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-ink-primary">Cross-Network Pairing</h2>
          <p className="text-xs text-ink-secondary">
            Bridge separate Wi-Fi, VLAN, or 5G networks via Warp Code or 19 kHz Sonic Drop
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close pairing panel"
            className="warp-btn warp-btn-subtle rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-1 text-xs text-ink-secondary"
          >
            Done
          </button>
        )}
      </div>

      {/* Mode Switcher */}
      <div role="tablist" aria-label="Pairing method" className="mt-3 grid grid-cols-2 gap-1.5 rounded-xl bg-black/40 p-1 border border-white/10">
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'warp'}
          onClick={() => setTab('warp')}
          className={`warp-btn rounded-lg py-1.5 text-xs font-medium ${
            tab === 'warp' ? 'bg-cyan-warp text-white' : 'text-ink-secondary hover:text-white'
          }`}
        >
          6-Char Warp Code
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'sonic'}
          onClick={() => setTab('sonic')}
          className={`warp-btn rounded-lg py-1.5 text-xs font-medium ${
            tab === 'sonic' ? 'bg-cyan-warp text-white' : 'text-ink-secondary hover:text-white'
          }`}
        >
          Sonic Drop (18.5–19.5 kHz)
        </button>
      </div>

      {sonicNotice && (
        <div
          role="status"
          className={`mt-3 rounded-xl border px-3 py-2 text-xs ${
            micDenied
              ? 'border-amber-system/45 bg-amber-system/12 text-amber-system'
              : 'border-cyan-ice/35 bg-cyan-warp/12 text-cyan-ice'
          }`}
        >
          <p>{sonicNotice}</p>
          {micDenied && isExtensionSidePanel && (
            <button
              type="button"
              onClick={openExtensionMicGrantTab}
              className="warp-btn mt-1.5 rounded-lg border border-amber-system/50 bg-amber-system/20 px-2.5 py-1 text-[11px] font-medium text-white"
            >
              Grant Microphone in Browser Tab
            </button>
          )}
        </div>
      )}

      {tab === 'warp' ? (
        <div className="mt-3 space-y-3">
          {/* Share / Host Session Code */}
          <div className="calm-row rounded-2xl p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-ink-tertiary">
                {activeWarpCode ? 'Active Session Token' : 'Your Ephemeral Warp Code'}
              </span>
              {activeWarpCode ? (
                <button
                  type="button"
                  onClick={() => void onLeaveWarpCode()}
                  className="warp-btn text-[11px] font-medium text-amber-system hover:underline"
                >
                  Leave Room
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setHostCode(generateWarpCode())}
                  className="warp-btn text-[11px] font-medium text-cyan-ice hover:underline"
                >
                  Regenerate
                </button>
              )}
            </div>

            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="tabular-nums font-mono text-2xl font-bold tracking-widest text-white">
                  {formatWarpCode(effectiveCode)}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleCopy('code')}
                    className="warp-btn warp-btn-primary rounded-lg bg-cyan-warp px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    {copied === 'code' ? 'Copied Code' : activeWarpCode ? 'Copy Code' : 'Open & Copy Code'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopy('link')}
                    className="warp-btn warp-btn-subtle rounded-lg border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-ink-primary"
                  >
                    {copied === 'link' ? 'Copied #warp Link' : 'Copy #warp Link'}
                  </button>
                </div>
              </div>

              {qrDataUrl && !compact && (
                <div className="rounded-xl border border-white/15 bg-black/55 p-1.5" title="Scan to join #warp deep-link">
                  <img
                    src={qrDataUrl}
                    alt={`QR code for Warp room ${formatWarpCode(effectiveCode)}`}
                    width={84}
                    height={84}
                    className="block rounded-lg"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Join Remote Peer's Code */}
          <form onSubmit={(e) => void handleManualJoin(e)} className="calm-row rounded-2xl p-3">
            <label htmlFor={inputId} className="block text-xs font-medium text-ink-primary">
              Enter Peer’s 6-Character Warp Code
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                ref={codeInputRef}
                id={inputId}
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={7}
                value={joinInput}
                onChange={(e) => {
                  setJoinInput(e.target.value.toUpperCase());
                  if (joinError) setJoinError(null);
                }}
                aria-invalid={joinError !== null}
                aria-describedby={joinError ? errorId : undefined}
                placeholder="A7X-92K"
                className="min-w-0 flex-1 rounded-xl border border-white/18 bg-black/55 px-3 py-2 font-mono text-sm uppercase tracking-widest text-white placeholder:text-white/25"
              />
              <button
                type="submit"
                className="warp-btn warp-btn-primary shrink-0 rounded-xl bg-cyan-warp px-4 py-2 text-xs font-semibold text-white"
              >
                Join Room
              </button>
            </div>
            {joinError && (
              <p id={errorId} className="mt-1.5 text-xs text-danger" role="alert">
                {joinError}
              </p>
            )}
          </form>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="calm-row rounded-2xl p-3">
            <div className="text-xs font-medium text-ink-primary">Near-Ultrasonic Acoustic Handshake</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">
              Modulates token <span className="font-mono text-white">{formatWarpCode(effectiveCode)}</span> into an 840 ms
              16-FSK chirp between 18.5 kHz and 19.5 kHz for same-room devices on separate networks.
            </p>

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => void handleEmitSonic()}
                className={`warp-btn rounded-xl px-3.5 py-2.5 text-xs font-semibold ${
                  isChirping
                    ? 'bg-lime-signal text-black'
                    : 'warp-btn-primary bg-cyan-warp text-white'
                }`}
              >
                {isChirping ? 'Transmitting 19 kHz Chirp…' : 'Broadcast Ultrasonic Chirp'}
              </button>

              <button
                type="button"
                onClick={() => void handleToggleListen()}
                className={`warp-btn rounded-xl border px-3.5 py-2.5 text-xs font-semibold ${
                  isListening
                    ? 'border-lime-signal bg-lime-signal/20 text-lime-signal'
                    : 'warp-btn-subtle border-white/18 bg-white/[0.06] text-ink-primary'
                }`}
              >
                {isListening ? 'Stop Microphone' : 'Listen via Microphone'}
              </button>
            </div>

            {/* Real-time 16-Tone Ultrasonic FFT Spectrum */}
            <div className="mt-3 rounded-xl border border-white/10 bg-black/50 p-2.5">
              <div className="flex items-center justify-between font-mono text-[10px] text-ink-tertiary">
                <span>18.50 kHz — 19.48 kHz FFT</span>
                <span className="tabular-nums">
                  {isListening ? `SNR ${spectrum.snrDb.toFixed(1)} dB` : 'Mic idle'}
                </span>
              </div>
              <div className="mt-2 flex h-10 items-end gap-1" aria-hidden="true">
                {spectrum.bins.map((level, idx) => (
                  <div
                    key={idx}
                    style={{ height: `${Math.max(12, Math.round(level * 100))}%` }}
                    className={`flex-1 rounded-sm transition-[height] duration-75 ${
                      spectrum.peakSymbol === idx
                        ? 'bg-lime-signal'
                        : isListening
                          ? 'bg-cyan-warp/70'
                          : 'bg-white/12'
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </GlassCard>
  );
};
