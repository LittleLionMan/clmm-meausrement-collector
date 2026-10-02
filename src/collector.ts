import { join } from "node:path";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import {
  loadConfig,
  type CollectorConfig,
  type EndpointConfig,
} from "./config.js";
import {
  decodeLeadingPool,
  decodeLiquidityChangeEvent,
  decodeSwapEvent,
  identifyEvent,
  impliedFeePpm,
  isLimitOrderEvent,
  isLiquidityChangeEventPlausible,
  isSwapEventPlausible,
  type IdentifiedEvent,
} from "./events.js";
import { isSwapInstruction, parseProgramLogs } from "./logParser.js";
import { NdjsonWriter, ensureDirectory, writeJsonFile } from "./output.js";

interface LogsNotification {
  readonly context: { readonly slot: bigint };
  readonly value: {
    readonly err: unknown;
    readonly logs: readonly string[];
    readonly signature: string;
  };
}

interface SeenEntry {
  readonly firstSeenAt: number;
  readonly slot: bigint;
  endpointMask: number;
}

interface EndpointCounters {
  notifications: number;
  duplicates: number;
  firstArrivals: number;
  connects: number;
  disconnects: number;
  downtimeMs: number;
  lastError: string | null;
}

interface WindowCounters {
  uniqueTx: number;
  failedTx: number;
  notInvokedTx: number;
  txWithEvents: number;
  truncatedTx: number;
  swapInstructionsWithoutEvent: number;
  events: Record<string, number>;
  unknownDiscriminators: Record<string, number>;
  swapPayloadLengths: Record<string, number>;
  implausibleSwapEvents: number;
  implausibleLiquidityEvents: number;
}

interface PoolStats {
  swaps: number;
  liquidityChanges: number;
  limitOrderEvents: number;
  feeObservations: number;
  minFeePpm: number | null;
  maxFeePpm: number | null;
  lastTick: number | null;
}

interface EndpointRuntime {
  readonly config: EndpointConfig;
  readonly index: number;
  counters: EndpointCounters;
  disconnectedSince: number | null;
}

const MINIMUM_FEE_FOR_RATE = 1_000n;

function emptyWindow(): WindowCounters {
  return {
    uniqueTx: 0,
    failedTx: 0,
    notInvokedTx: 0,
    txWithEvents: 0,
    truncatedTx: 0,
    swapInstructionsWithoutEvent: 0,
    events: {},
    unknownDiscriminators: {},
    swapPayloadLengths: {},
    implausibleSwapEvents: 0,
    implausibleLiquidityEvents: 0,
  };
}

function emptyEndpointCounters(): EndpointCounters {
  return {
    notifications: 0,
    duplicates: 0,
    firstArrivals: 0,
    connects: 0,
    disconnects: 0,
    downtimeMs: 0,
    lastError: null,
  };
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class MeasurementCollector {
  private readonly seen = new Map<string, SeenEntry>();
  private readonly pools = new Map<string, PoolStats>();
  private readonly endpoints: EndpointRuntime[];
  private readonly eventWriter: NdjsonWriter;
  private readonly statsWriter: NdjsonWriter;
  private readonly coverageWriter: NdjsonWriter;
  private window = emptyWindow();
  private windowStartedAt = Date.now();
  private latestSlot = 0n;
  private coverageRound = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly config: CollectorConfig) {
    this.endpoints = config.endpoints.map((endpoint, index) => ({
      config: endpoint,
      index,
      counters: emptyEndpointCounters(),
      disconnectedSince: Date.now(),
    }));
    this.eventWriter = new NdjsonWriter(config.dataDir, "events", true);
    this.statsWriter = new NdjsonWriter(config.dataDir, "stats", false);
    this.coverageWriter = new NdjsonWriter(config.dataDir, "coverage", false);
  }

  async run(shutdown: AbortSignal): Promise<void> {
    await writeJsonFile(join(this.config.dataDir, "run.json"), {
      startedAt: new Date(this.startedAt).toISOString(),
      programId: this.config.programId,
      endpoints: this.config.endpoints.map((endpoint) => endpoint.name),
      plannedDurationMs: this.config.durationMs,
    });

    const intervals = [
      setInterval(() => this.flushStats(), this.config.statsIntervalMs),
      setInterval(
        () => void this.sampleCoverage(),
        this.config.coverageIntervalMs,
      ),
      setInterval(
        () => void this.writePoolSnapshot(),
        this.config.poolSnapshotIntervalMs,
      ),
      setInterval(() => this.pruneSeen(), 60_000),
    ];

    await Promise.all(
      this.endpoints.map((endpoint) => this.runEndpoint(endpoint, shutdown)),
    );

    for (const interval of intervals) {
      clearInterval(interval);
    }
    this.flushStats();
    await this.writePoolSnapshot();
    await writeJsonFile(join(this.config.dataDir, "run-end.json"), {
      endedAt: new Date().toISOString(),
      runtimeMs: Date.now() - this.startedAt,
    });
    await Promise.all([
      this.eventWriter.close(),
      this.statsWriter.close(),
      this.coverageWriter.close(),
    ]);
  }

  private async runEndpoint(
    endpoint: EndpointRuntime,
    shutdown: AbortSignal,
  ): Promise<void> {
    const subscriptions = createSolanaRpcSubscriptions(endpoint.config.wsUrl);
    let backoffMs = 1_000;

    while (!shutdown.aborted) {
      const connection = new AbortController();
      const abortConnection = (): void => connection.abort();
      shutdown.addEventListener("abort", abortConnection, { once: true });
      let lastMessageAt = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastMessageAt > this.config.staleAfterMs) {
          endpoint.counters.lastError =
            "stale: keine Nachrichten innerhalb des Watchdog-Fensters";
          connection.abort();
        }
      }, 5_000);

      try {
        const notifications = await subscriptions
          .logsNotifications(
            { mentions: [this.config.programId] },
            { commitment: "confirmed" },
          )
          .subscribe({ abortSignal: connection.signal });
        endpoint.counters.connects += 1;
        lastMessageAt = Date.now();
        for await (const notification of notifications) {
          lastMessageAt = Date.now();
          backoffMs = 1_000;
          if (endpoint.disconnectedSince !== null) {
            endpoint.counters.downtimeMs +=
              lastMessageAt - endpoint.disconnectedSince;
            endpoint.disconnectedSince = null;
          }
          this.handleNotification(endpoint, notification);
        }
      } catch (error) {
        if (!shutdown.aborted) {
          endpoint.counters.lastError = errorMessage(error);
        }
      } finally {
        clearInterval(watchdog);
        shutdown.removeEventListener("abort", abortConnection);
      }

      if (shutdown.aborted) {
        break;
      }
      endpoint.counters.disconnects += 1;
      endpoint.disconnectedSince ??= Date.now();
      await sleep(backoffMs, shutdown);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }

    if (endpoint.disconnectedSince !== null) {
      endpoint.counters.downtimeMs += Date.now() - endpoint.disconnectedSince;
      endpoint.disconnectedSince = null;
    }
  }

  private handleNotification(
    endpoint: EndpointRuntime,
    notification: LogsNotification,
  ): void {
    const { signature, err, logs } = notification.value;
    const slot = notification.context.slot;
    const bit = 1 << endpoint.index;
    endpoint.counters.notifications += 1;
    if (slot > this.latestSlot) {
      this.latestSlot = slot;
    }

    const existing = this.seen.get(signature);
    if (existing !== undefined) {
      endpoint.counters.duplicates += 1;
      existing.endpointMask |= bit;
      return;
    }

    const receivedAt = Date.now();
    this.seen.set(signature, {
      firstSeenAt: receivedAt,
      slot,
      endpointMask: bit,
    });
    endpoint.counters.firstArrivals += 1;
    this.window.uniqueTx += 1;

    const failed = err !== null;
    if (failed) {
      this.window.failedTx += 1;
    }

    const parsed = parseProgramLogs(logs, this.config.programId);
    if (parsed.truncated) {
      this.window.truncatedTx += 1;
    }
    if (!parsed.programInvoked) {
      this.window.notInvokedTx += 1;
    }

    const events = parsed.eventData
      .map((data) => identifyEvent(data))
      .filter((event): event is IdentifiedEvent => event !== null);

    if (!failed) {
      this.analyzeEvents(events, parsed.instructions, parsed.truncated);
    }

    if (
      events.length === 0 &&
      parsed.instructions.length === 0 &&
      !parsed.truncated
    ) {
      return;
    }

    this.eventWriter.write({
      signature,
      slot,
      receivedAt,
      endpoint: endpoint.config.name,
      failed,
      truncated: parsed.truncated,
      instructions: parsed.instructions,
      events: events.map((event) => ({
        name: event.name,
        discriminator: event.discriminator,
        data: event.dataBase64,
      })),
    });
  }

  private analyzeEvents(
    events: readonly IdentifiedEvent[],
    instructions: readonly string[],
    truncated: boolean,
  ): void {
    if (events.length > 0) {
      this.window.txWithEvents += 1;
    }
    let swapEvents = 0;

    for (const event of events) {
      increment(this.window.events, event.name);
      if (event.name === "Unknown") {
        increment(this.window.unknownDiscriminators, event.discriminator);
        continue;
      }
      if (event.name === "SwapEvent") {
        swapEvents += 1;
        increment(this.window.swapPayloadLengths, String(event.payload.length));
        const swap = decodeSwapEvent(event.payload);
        if (swap === null || !isSwapEventPlausible(swap)) {
          this.window.implausibleSwapEvents += 1;
          continue;
        }
        const stats = this.poolStats(swap.pool);
        stats.swaps += 1;
        stats.lastTick = swap.tick;
        const feePpm = impliedFeePpm(swap, MINIMUM_FEE_FOR_RATE);
        if (feePpm !== null) {
          stats.feeObservations += 1;
          stats.minFeePpm =
            stats.minFeePpm === null
              ? feePpm
              : Math.min(stats.minFeePpm, feePpm);
          stats.maxFeePpm =
            stats.maxFeePpm === null
              ? feePpm
              : Math.max(stats.maxFeePpm, feePpm);
        }
        continue;
      }
      if (event.name === "LiquidityChangeEvent") {
        const change = decodeLiquidityChangeEvent(event.payload);
        if (change === null || !isLiquidityChangeEventPlausible(change)) {
          this.window.implausibleLiquidityEvents += 1;
          continue;
        }
        this.poolStats(change.pool).liquidityChanges += 1;
        continue;
      }
      if (isLimitOrderEvent(event.name)) {
        const pool = decodeLeadingPool(event.payload);
        if (pool !== null) {
          this.poolStats(pool).limitOrderEvents += 1;
        }
      }
    }

    const swapInstructions = instructions.filter((name) =>
      isSwapInstruction(name),
    ).length;
    if (!truncated && swapInstructions > 0 && swapEvents === 0) {
      this.window.swapInstructionsWithoutEvent += 1;
    }
  }

  private poolStats(pool: string): PoolStats {
    const existing = this.pools.get(pool);
    if (existing !== undefined) {
      return existing;
    }
    const created: PoolStats = {
      swaps: 0,
      liquidityChanges: 0,
      limitOrderEvents: 0,
      feeObservations: 0,
      minFeePpm: null,
      maxFeePpm: null,
      lastTick: null,
    };
    this.pools.set(pool, created);
    return created;
  }

  private flushStats(): void {
    const now = Date.now();
    this.statsWriter.write({
      ts: new Date(now).toISOString(),
      windowMs: now - this.windowStartedAt,
      ...this.window,
      bytesWritten: this.eventWriter.takeWrittenBytes(),
      seenSize: this.seen.size,
      knownPools: this.pools.size,
      latestSlot: this.latestSlot,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
      endpoints: this.endpoints.map((endpoint) => ({
        name: endpoint.config.name,
        ...endpoint.counters,
      })),
    });
    this.window = emptyWindow();
    this.windowStartedAt = now;
    for (const endpoint of this.endpoints) {
      endpoint.counters = {
        ...emptyEndpointCounters(),
        lastError: endpoint.counters.lastError,
      };
    }
    const elapsedMinutes = Math.round((now - this.startedAt) / 60_000);
    process.stdout.write(
      `[${new Date(now).toISOString()}] Laufzeit ${elapsedMinutes} min, Pools ${this.pools.size}, Slot ${this.latestSlot}\n`,
    );
  }

  private async sampleCoverage(): Promise<void> {
    const source = this.endpoints[this.coverageRound % this.endpoints.length];
    this.coverageRound += 1;
    if (source === undefined || this.latestSlot === 0n) {
      return;
    }
    try {
      const rpc = createSolanaRpc(source.config.httpUrl);
      const signatures = await rpc
        .getSignaturesForAddress(this.config.programId, {
          limit: 1000,
          commitment: "confirmed",
        })
        .send();
      const now = Date.now();
      const maxSlot = this.latestSlot - this.config.coverageMinAgeSlots;
      const missingPerEndpoint: Record<string, number> = {};
      for (const endpoint of this.endpoints) {
        missingPerEndpoint[endpoint.config.name] = 0;
      }
      let checked = 0;
      let missingAll = 0;
      const missingExamples: string[] = [];

      for (const item of signatures) {
        if (item.slot > maxSlot || item.blockTime === null) {
          continue;
        }
        const blockTimeMs = Number(item.blockTime) * 1000;
        if (
          blockTimeMs < this.startedAt + 60_000 ||
          blockTimeMs < now - this.config.seenRetentionMs + 120_000
        ) {
          continue;
        }
        checked += 1;
        const entry = this.seen.get(item.signature);
        if (entry === undefined) {
          missingAll += 1;
          if (missingExamples.length < 10) {
            missingExamples.push(item.signature);
          }
        }
        for (const endpoint of this.endpoints) {
          if (
            entry === undefined ||
            (entry.endpointMask & (1 << endpoint.index)) === 0
          ) {
            missingPerEndpoint[endpoint.config.name] =
              (missingPerEndpoint[endpoint.config.name] ?? 0) + 1;
          }
        }
      }

      this.coverageWriter.write({
        ts: new Date(now).toISOString(),
        source: source.config.name,
        returned: signatures.length,
        checked,
        missingAll,
        missingPerEndpoint,
        missingExamples,
      });
    } catch (error) {
      this.coverageWriter.write({
        ts: new Date().toISOString(),
        source: source.config.name,
        error: errorMessage(error),
      });
    }
  }

  private async writePoolSnapshot(): Promise<void> {
    const pools = Object.fromEntries(this.pools.entries());
    await writeJsonFile(join(this.config.dataDir, "pools.json"), {
      updatedAt: new Date().toISOString(),
      pools,
    });
  }

  private pruneSeen(): void {
    const threshold = Date.now() - this.config.seenRetentionMs;
    for (const [signature, entry] of this.seen) {
      if (entry.firstSeenAt >= threshold) {
        break;
      }
      this.seen.delete(signature);
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureDirectory(config.dataDir);
  const shutdown = new AbortController();
  const stop = (reason: string): void => {
    if (!shutdown.signal.aborted) {
      process.stdout.write(`Beende Messung (${reason}) ...\n`);
      shutdown.abort();
    }
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  const timer = setTimeout(
    () => stop("geplante Laufzeit erreicht"),
    config.durationMs,
  );

  process.stdout.write(
    `Starte Messung: ${config.endpoints.map((endpoint) => endpoint.name).join(", ")} | Laufzeit ${config.durationMs / 3_600_000} h | Daten in ${config.dataDir}\n`,
  );
  await new MeasurementCollector(config).run(shutdown.signal);
  clearTimeout(timer);
  process.stdout.write("Messung beendet. Auswertung mit: npm run report\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`Fataler Fehler: ${errorMessage(error)}\n`);
  process.exit(1);
});
