import {
  CHUNK_LADDER,
  FRAME_HEADER_BYTES,
  formatBytes,
  type Bottleneck,
  type IceRoute,
  type SchedulePolicy,
  type SinkKind,
  type TuneConfig,
  type WorkerChannelMode,
} from './protocol';

export type BenchmarkPresetId =
  | 'quick-autotune'
  | 'repeat-3x'
  | 'chunk-sweep'
  | 'channel-lane-sweep'
  | 'worker-vs-bridge'
  | 'sink-and-lz4';

export interface BenchmarkUserMetadata {
  networkTag: string;
  powerTag: string;
}

export interface BenchmarkStepSpec {
  label: string;
  warmup?: boolean;
  durationMs: number;
  compressible: boolean;
  compress: boolean;
  preferredSink: 'auto' | SinkKind;
  windowOverride?: number;
  forceBridge?: boolean;
  pinned?: Partial<TuneConfig> | null;
}

export interface BenchmarkRunResult {
  id: string;
  label: string;
  warmup: boolean;
  timestamp: string;
  // 1. Route & ICE Evidence
  route: IceRoute;
  candidatePairLabel: string;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  protocol: string | null;
  relayProtocol: string | null;
  rttMs: number | null;
  ctrlPingIdleMs: number | null;
  ctrlPingLoadedMs: number | null;
  availableOutgoingBitrateMbps: number | null;
  // 2. Application vs Wire vs getStats() Throughput & Timing
  bytes: number;
  wireBytes: number;
  setupMs: number;
  elapsedMs: number;
  receiverFinalizeMs: number;
  appMBps: number;
  wireMBps: number;
  statsWireMBps: number;
  compressionRatio: number;
  // 3. Sender Queue, Striping, Worker Mode & Autotuner
  chunkSize: number;
  activeLanes: number;
  activeChannels: number;
  schedule: SchedulePolicy;
  highWatermark: number;
  workerMode: WorkerChannelMode;
  bridgeHandoffs: number;
  bridgeWaitMs: number;
  queueWaitPct: number;
  creditWaitPct: number;
  diskWaitPct: number;
  bottleneck: Bottleneck;
  tunerDecision: string;
  // 4. Receiver Sink & Credit Backpressure
  sink: SinkKind;
  receiverWriteMs: number;
  receiverWriteMBps: number | null;
  maxPendingWriteBytes: number;
  creditWindowBytes: number;
  // 5. Integrity & Environment Metadata
  senderHash: string;
  receiverHash: string;
  hashMatch: boolean;
  complete: boolean;
  senderEnv: string;
  receiverEnv: string;
  networkTag: string;
  powerTag: string;
}

export interface BenchmarkSuiteSummary {
  preset: BenchmarkPresetId;
  runs: BenchmarkRunResult[];
  medianMBps: number;
  p95VariationPct: number;
  bestRun: BenchmarkRunResult | null;
  recommendedConfig: Partial<TuneConfig> | null;
  allHashesVerified: boolean;
}

export function buildPresetSteps(
  preset: BenchmarkPresetId,
  maxSctpMessageSize: number | null,
  maxLanes: number,
  opfsAvailable: boolean,
  opfsSyncAvailable: boolean,
  nativeWorkerSupported = true,
): BenchmarkStepSpec[] {
  const sctpCap = maxSctpMessageSize && maxSctpMessageSize > 0 ? maxSctpMessageSize : 256 * 1024 + 64;
  const validChunks = CHUNK_LADDER.filter((c) => c + FRAME_HEADER_BYTES <= sctpCap);

  switch (preset) {
    case 'quick-autotune':
      return [
        {
          label: 'Warm-up (SCTP slow-start)',
          warmup: true,
          durationMs: 1_200,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          pinned: null,
        },
        {
          label: 'Autotuned Link Ceiling',
          durationMs: 4_200,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          pinned: null,
        },
      ];

    case 'repeat-3x':
      return [
        {
          label: 'Warm-up',
          warmup: true,
          durationMs: 1_200,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          pinned: null,
        },
        ...[1, 2, 3].map((i) => ({
          label: `Repeat #${i} (Incompressible)`,
          durationMs: 3_500,
          compressible: false,
          compress: false,
          preferredSink: (opfsAvailable ? 'auto' : 'discard') as 'auto' | SinkKind,
          pinned: null,
        })),
      ];

    case 'chunk-sweep':
      return [
        {
          label: 'Warm-up',
          warmup: true,
          durationMs: 1_000,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          pinned: { chunk: 64 * 1024, lanes: 1 },
        },
        ...validChunks.map((chunk) => ({
          label: `Chunk ${Math.round(chunk / 1024)} KiB`,
          durationMs: 2_600,
          compressible: false,
          compress: false,
          preferredSink: 'discard' as const,
          pinned: { chunk, lanes: Math.min(2, maxLanes) },
        })),
      ];

    case 'channel-lane-sweep': {
      const steps: BenchmarkStepSpec[] = [
        {
          label: 'Warm-up',
          warmup: true,
          durationMs: 1_000,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          pinned: { channels: 4, lanes: 1 },
        },
        {
          label: '1 Channel · 1 Lane',
          durationMs: 2_600,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          pinned: { channels: 1, lanes: 1, schedule: 'least-buffered' },
        },
        {
          label: '2 Channels · 1 Lane',
          durationMs: 2_600,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          pinned: { channels: 2, lanes: 1, schedule: 'least-buffered' },
        },
        {
          label: '4 Channels · Least-Buffered',
          durationMs: 2_600,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          pinned: { channels: 4, lanes: 1, schedule: 'least-buffered' },
        },
        {
          label: '4 Channels · Round-Robin',
          durationMs: 2_600,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          pinned: { channels: 4, lanes: 1, schedule: 'round-robin' },
        },
      ];
      if (maxLanes >= 2) {
        steps.push({
          label: `Parallel SCTP (${maxLanes} Lanes)`,
          durationMs: 3_000,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          pinned: { channels: 4, lanes: maxLanes, schedule: 'least-buffered' },
        });
      }
      return steps;
    }

    case 'worker-vs-bridge':
      if (!nativeWorkerSupported) {
        return [
          {
            label: 'Warm-up',
            warmup: true,
            durationMs: 1_000,
            compressible: false,
            compress: false,
            preferredSink: 'discard',
          },
          {
            label: 'Bridge · Autotuned (Worker DC unsupported)',
            durationMs: 3_200,
            compressible: false,
            compress: false,
            preferredSink: 'discard',
            forceBridge: false,
          },
          {
            label: 'Bridge · Pinned 64 KiB × 1 Lane',
            durationMs: 3_200,
            compressible: false,
            compress: false,
            preferredSink: 'discard',
            forceBridge: false,
            pinned: { chunk: Math.min(64 * 1024, validChunks[validChunks.length - 1] ?? 64 * 1024), lanes: 1, channels: 4 },
          },
        ];
      }
      return [
        {
          label: 'Warm-up',
          warmup: true,
          durationMs: 1_000,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
        },
        {
          label: 'Worker-Owned DataChannels',
          durationMs: 3_200,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          forceBridge: false,
        },
        {
          label: 'Transferable ArrayBuffer Bridge',
          durationMs: 3_200,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
          forceBridge: true,
        },
      ];

    case 'sink-and-lz4': {
      const steps: BenchmarkStepSpec[] = [
        {
          label: 'Network Only (Discard Sink)',
          durationMs: 2_800,
          compressible: false,
          compress: false,
          preferredSink: 'discard',
        },
      ];
      if (opfsSyncAvailable) {
        steps.push({
          label: 'OPFS SyncAccessHandle',
          durationMs: 2_800,
          compressible: false,
          compress: false,
          preferredSink: 'opfs-sync',
        });
      }
      if (opfsAvailable) {
        steps.push({
          label: 'OPFS Async Writable (8 MiB Credit Cap)',
          durationMs: 2_800,
          compressible: false,
          compress: false,
          preferredSink: 'opfs-writable',
          windowOverride: 8 * 1024 * 1024,
        });
      }
      steps.push(
        {
          label: 'Structured Text · Raw (LZ4 Off)',
          durationMs: 2_600,
          compressible: true,
          compress: false,
          preferredSink: 'discard',
        },
        {
          label: 'Structured Text · WASM LZ4 On',
          durationMs: 2_600,
          compressible: true,
          compress: true,
          preferredSink: 'discard',
        },
      );
      return steps;
    }
  }
}

export function summarizeBenchmarkSuite(
  preset: BenchmarkPresetId,
  runs: BenchmarkRunResult[],
): BenchmarkSuiteSummary {
  const measured = runs.filter((r) => !r.warmup);
  const sampleSet = measured.length > 0 ? measured : runs;
  const speeds = sampleSet.map((r) => r.appMBps).sort((a, b) => a - b);

  const medianMBps =
    speeds.length === 0
      ? 0
      : speeds.length % 2 === 1
        ? speeds[Math.floor(speeds.length / 2)]
        : Math.round(((speeds[speeds.length / 2 - 1] + speeds[speeds.length / 2]) / 2) * 10) / 10;

  let p95VariationPct = 0;
  if (speeds.length >= 2 && medianMBps > 0) {
    const p95Idx = Math.min(speeds.length - 1, Math.floor(speeds.length * 0.95));
    const spread = Math.max(Math.abs(speeds[p95Idx] - medianMBps), Math.abs(medianMBps - speeds[0]));
    p95VariationPct = Math.round((spread / medianMBps) * 1000) / 10;
  }

  // Pick best raw-network run (excluding synthetic LZ4 compression inflation) for transport recommendation
  const rawCandidates = sampleSet.filter((r) => r.compressionRatio <= 1.05 && !r.label.includes('Bridge'));
  const pool = rawCandidates.length > 0 ? rawCandidates : sampleSet;
  let bestRun: BenchmarkRunResult | null = null;
  for (const r of pool) {
    if (!bestRun || r.appMBps > bestRun.appMBps) bestRun = r;
  }

  const recommendedConfig: Partial<TuneConfig> | null = bestRun
    ? {
        chunk: bestRun.chunkSize,
        lanes: bestRun.activeLanes,
        highWatermark: bestRun.highWatermark,
        channels: bestRun.activeChannels,
        schedule: bestRun.schedule,
      }
    : null;

  return {
    preset,
    runs,
    medianMBps,
    p95VariationPct,
    bestRun,
    recommendedConfig,
    allHashesVerified: sampleSet.every((r) => r.hashMatch && r.complete),
  };
}

export function formatSuiteMarkdownReport(summary: BenchmarkSuiteSummary): string {
  const lines: string[] = [
    `# PointerDrop Benchmark Report (${summary.preset})`,
    `- Generated: ${new Date().toISOString()}`,
    `- Median App Throughput: **${summary.medianMBps.toFixed(1)} MB/s** (±${summary.p95VariationPct}% variation)`,
    `- Integrity Verification: **${summary.allHashesVerified ? 'PASS (100% 128-bit block hashes matched)' : 'WARN (mismatch/incomplete)'}**`,
  ];
  if (summary.bestRun) {
    const b = summary.bestRun;
    lines.push(
      `- Best Config: **${Math.round(b.chunkSize / 1024)} KiB** chunk · **${b.activeLanes} SCTP lane(s)** · **${b.activeChannels} ch (${b.schedule})** · **${formatBytes(b.highWatermark, 0)} WM**`,
      `- Route Evidence: \`${b.candidatePairLabel}\` (RTT ${b.rttMs ?? '—'} ms, Loaded Ping ${b.ctrlPingLoadedMs ?? '—'} ms)`,
      `- Endpoints: \`${b.senderEnv}\` → \`${b.receiverEnv}\` (${b.networkTag}, ${b.powerTag})`,
    );
  }
  lines.push(
    '',
    '| Step | Route Pair | App MB/s | Wire MB/s | Stats MB/s | Chunk / Lanes / Ch | Queue / Credit Wait | Sink (Write MB/s) | Ping Idle→Load | Hash |',
    '| :--- | :--- | ---: | ---: | ---: | :--- | ---: | :--- | ---: | :---: |',
  );
  for (const r of summary.runs) {
    const writeStr = r.receiverWriteMBps !== null ? `${r.sink} (${r.receiverWriteMBps.toFixed(0)} MB/s)` : r.sink;
    lines.push(
      `| ${r.warmup ? `[Warm] ${r.label}` : r.label} | \`${r.candidatePairLabel}\` | **${r.appMBps.toFixed(1)}** | ${r.wireMBps.toFixed(1)} | ${r.statsWireMBps.toFixed(1)} | ${Math.round(r.chunkSize / 1024)}K / ${r.activeLanes}L / ${r.activeChannels}c | ${r.queueWaitPct}% / ${r.creditWaitPct}% | ${writeStr} | ${r.ctrlPingIdleMs ?? '—'}→${r.ctrlPingLoadedMs ?? '—'} ms | ${r.hashMatch ? '✓' : '✗'} |`,
    );
  }
  return lines.join('\n');
}
