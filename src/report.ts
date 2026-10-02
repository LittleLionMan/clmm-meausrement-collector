import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { writeJsonFile } from "./output.js";

interface EndpointStats {
  readonly name: string;
  readonly notifications: number;
  readonly duplicates: number;
  readonly firstArrivals: number;
  readonly connects: number;
  readonly disconnects: number;
  readonly downtimeMs: number;
  readonly lastError: string | null;
}

interface StatsRecord {
  readonly ts: string;
  readonly windowMs: number;
  readonly uniqueTx: number;
  readonly failedTx: number;
  readonly notInvokedTx: number;
  readonly txWithEvents: number;
  readonly truncatedTx: number;
  readonly swapInstructionsWithoutEvent: number;
  readonly events: Readonly<Record<string, number>>;
  readonly unknownDiscriminators: Readonly<Record<string, number>>;
  readonly swapPayloadLengths: Readonly<Record<string, number>>;
  readonly implausibleSwapEvents: number;
  readonly implausibleLiquidityEvents: number;
  readonly bytesWritten: number;
  readonly heapUsedMb: number;
  readonly endpoints: readonly EndpointStats[];
}

interface CoverageRecord {
  readonly ts: string;
  readonly source: string;
  readonly checked?: number;
  readonly missingAll?: number;
  readonly missingPerEndpoint?: Readonly<Record<string, number>>;
  readonly error?: string;
}

interface PoolStats {
  readonly swaps: number;
  readonly liquidityChanges: number;
  readonly limitOrderEvents: number;
  readonly feeObservations: number;
  readonly minFeePpm: number | null;
  readonly maxFeePpm: number | null;
}

interface PoolSnapshot {
  readonly updatedAt: string;
  readonly pools: Readonly<Record<string, PoolStats>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStatsRecord(value: unknown): value is StatsRecord {
  return (
    isObject(value) &&
    typeof value["ts"] === "string" &&
    typeof value["uniqueTx"] === "number" &&
    Array.isArray(value["endpoints"])
  );
}

function isCoverageRecord(value: unknown): value is CoverageRecord {
  return (
    isObject(value) &&
    typeof value["ts"] === "string" &&
    typeof value["source"] === "string"
  );
}

function isPoolSnapshot(value: unknown): value is PoolSnapshot {
  return (
    isObject(value) &&
    typeof value["updatedAt"] === "string" &&
    isObject(value["pools"])
  );
}

async function readNdjson<T>(
  path: string,
  guard: (value: unknown) => value is T,
): Promise<T[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  const records: T[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const value: unknown = JSON.parse(line);
    if (guard(value)) {
      records.push(value);
    }
  }
  return records;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mergeCounts(
  records: readonly Readonly<Record<string, number>>[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      result[key] = (result[key] ?? 0) + value;
    }
  }
  return result;
}

function percent(part: number, total: number): string {
  return total === 0 ? "n/a" : `${((part / total) * 100).toFixed(3)} %`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

async function estimateCompressionRatio(
  dataDir: string,
): Promise<number | null> {
  const files = (await readdir(dataDir)).filter(
    (file) => file.startsWith("events-") && file.endsWith(".ndjson"),
  );
  let largest: { file: string; size: number } | null = null;
  for (const file of files) {
    const { size } = await stat(join(dataDir, file));
    if (largest === null || size > largest.size) {
      largest = { file, size };
    }
  }
  if (largest === null || largest.size === 0) {
    return null;
  }
  const content = await readFile(join(dataDir, largest.file));
  return gzipSync(content).length / content.length;
}

async function main(): Promise<void> {
  const dataDir = process.env["DATA_DIR"] ?? "./data";
  const stats = await readNdjson(join(dataDir, "stats.ndjson"), isStatsRecord);
  const coverage = await readNdjson(
    join(dataDir, "coverage.ndjson"),
    isCoverageRecord,
  );
  const snapshotRaw: unknown = JSON.parse(
    await readFile(join(dataDir, "pools.json"), "utf8").catch(() => "null"),
  );
  const pools = isPoolSnapshot(snapshotRaw) ? snapshotRaw.pools : {};

  if (stats.length === 0) {
    process.stdout.write("Keine Statistikdaten gefunden.\n");
    return;
  }

  const runtimeMs = sum(stats.map((record) => record.windowMs));
  const runtimeDays = runtimeMs / 86_400_000;
  const perMinuteTx = stats.map(
    (record) => (record.uniqueTx * 60_000) / Math.max(record.windowMs, 1),
  );
  const uniqueTx = sum(stats.map((record) => record.uniqueTx));
  const txWithEvents = sum(stats.map((record) => record.txWithEvents));
  const truncatedTx = sum(stats.map((record) => record.truncatedTx));
  const bytesWritten = sum(stats.map((record) => record.bytesWritten));
  const events = mergeCounts(stats.map((record) => record.events));
  const unknownDiscriminators = mergeCounts(
    stats.map((record) => record.unknownDiscriminators),
  );
  const swapPayloadLengths = mergeCounts(
    stats.map((record) => record.swapPayloadLengths),
  );
  const compressionRatio = await estimateCompressionRatio(dataDir);

  const endpointNames = [
    ...new Set(
      stats.flatMap((record) =>
        record.endpoints.map((endpoint) => endpoint.name),
      ),
    ),
  ];
  const endpointSummary = endpointNames.map((name) => {
    const rows = stats.flatMap((record) =>
      record.endpoints.filter((endpoint) => endpoint.name === name),
    );
    const coverageChecked = sum(coverage.map((record) => record.checked ?? 0));
    const coverageMissing = sum(
      coverage.map((record) => record.missingPerEndpoint?.[name] ?? 0),
    );
    return {
      name,
      notifications: sum(rows.map((row) => row.notifications)),
      firstArrivals: sum(rows.map((row) => row.firstArrivals)),
      disconnects: sum(rows.map((row) => row.disconnects)),
      downtimeMinutes: Math.round(
        sum(rows.map((row) => row.downtimeMs)) / 60_000,
      ),
      missingRate: percent(coverageMissing, coverageChecked),
      lastError: rows.at(-1)?.lastError ?? null,
    };
  });

  const coverageChecked = sum(coverage.map((record) => record.checked ?? 0));
  const coverageMissingAll = sum(
    coverage.map((record) => record.missingAll ?? 0),
  );
  const coverageErrors = coverage.filter(
    (record) => record.error !== undefined,
  ).length;

  const poolEntries = Object.entries(pools);
  const swapThresholds = [10, 100, 1_000, 10_000].map((threshold) => ({
    threshold,
    pools: poolEntries.filter(([, pool]) => pool.swaps >= threshold).length,
  }));
  const dynamicFeeCandidates = poolEntries.filter(
    ([, pool]) =>
      pool.feeObservations >= 20 &&
      pool.minFeePpm !== null &&
      pool.maxFeePpm !== null &&
      pool.maxFeePpm > pool.minFeePpm * 1.05,
  ).length;
  const poolsWithLimitOrders = poolEntries.filter(
    ([, pool]) => pool.limitOrderEvents > 0,
  ).length;
  const topPools = [...poolEntries]
    .sort(([, a], [, b]) => b.swaps - a.swaps)
    .slice(0, 15)
    .map(([address, pool]) => ({ address, ...pool }));

  const report = {
    runtimeHours: Number((runtimeMs / 3_600_000).toFixed(2)),
    transactions: {
      unique: uniqueTx,
      perDay: Math.round(uniqueTx / runtimeDays),
      perMinute: {
        p50: Math.round(percentile(perMinuteTx, 50)),
        p95: Math.round(percentile(perMinuteTx, 95)),
        p99: Math.round(percentile(perMinuteTx, 99)),
        max: Math.round(percentile(perMinuteTx, 100)),
      },
      failed: sum(stats.map((record) => record.failedTx)),
      withoutProgramInvocation: sum(stats.map((record) => record.notInvokedTx)),
      withEvents: txWithEvents,
    },
    events: Object.fromEntries(
      Object.entries(events).map(([name, count]) => [
        name,
        { total: count, perDay: Math.round(count / runtimeDays) },
      ]),
    ),
    integrity: {
      truncatedTxRate: percent(truncatedTx, uniqueTx),
      truncatedTx,
      swapInstructionsWithoutEvent: sum(
        stats.map((record) => record.swapInstructionsWithoutEvent),
      ),
      unknownDiscriminators,
      swapPayloadLengths,
      implausibleSwapEvents: sum(
        stats.map((record) => record.implausibleSwapEvents),
      ),
      implausibleLiquidityEvents: sum(
        stats.map((record) => record.implausibleLiquidityEvents),
      ),
    },
    storage: {
      rawPerDay: megabytes(bytesWritten / runtimeDays),
      gzipRatio:
        compressionRatio === null ? null : Number(compressionRatio.toFixed(3)),
      compressedPerDayEstimate:
        compressionRatio === null
          ? null
          : megabytes((bytesWritten / runtimeDays) * compressionRatio),
      peakHeapMb: Math.max(...stats.map((record) => record.heapUsedMb)),
    },
    endpoints: endpointSummary,
    coverage: {
      samples: coverage.length,
      samplingErrors: coverageErrors,
      checkedSignatures: coverageChecked,
      missingInAllEndpoints: coverageMissingAll,
      missingRate: percent(coverageMissingAll, coverageChecked),
    },
    pools: {
      seen: poolEntries.length,
      bySwapCount: swapThresholds,
      withLimitOrderActivity: poolsWithLimitOrders,
      dynamicFeeCandidates,
      top: topPools,
    },
  };

  await writeJsonFile(join(dataDir, "report.json"), report);

  const lines = [
    `Laufzeit: ${report.runtimeHours} h`,
    `Transaktionen: ${uniqueTx} gesamt, ca. ${report.transactions.perDay}/Tag, pro Minute p50 ${report.transactions.perMinute.p50} / p99 ${report.transactions.perMinute.p99} / max ${report.transactions.perMinute.max}`,
    `Events: ${Object.entries(events)
      .map(([name, count]) => `${name} ${count}`)
      .join(", ")}`,
    `Abgeschnittene Logs: ${report.integrity.truncatedTxRate} (${truncatedTx} Tx)`,
    `Swap-Instruktion ohne SwapEvent (nicht abgeschnitten): ${report.integrity.swapInstructionsWithoutEvent}`,
    `SwapEvent-Payloadlängen: ${JSON.stringify(swapPayloadLengths)} (213 = mit trade_fee, 197 = altes Layout)`,
    `Unplausible Events: Swap ${report.integrity.implausibleSwapEvents}, LiquidityChange ${report.integrity.implausibleLiquidityEvents}`,
    `Unbekannte Diskriminatoren: ${JSON.stringify(unknownDiscriminators)}`,
    `Speicher: ${report.storage.rawPerDay}/Tag roh, gzip-Faktor ${report.storage.gzipRatio ?? "n/a"}, ca. ${report.storage.compressedPerDayEstimate ?? "n/a"}/Tag komprimiert, Heap max ${report.storage.peakHeapMb} MB`,
    `Coverage: ${coverageChecked} Signaturen geprüft, in allen Endpoints fehlend: ${report.coverage.missingRate}, Stichprobenfehler: ${coverageErrors}`,
    ...endpointSummary.map(
      (endpoint) =>
        `Endpoint ${endpoint.name}: ${endpoint.notifications} Nachrichten, ${endpoint.firstArrivals} zuerst, ${endpoint.disconnects} Abbrüche, ${endpoint.downtimeMinutes} min Ausfall, fehlend ${endpoint.missingRate}`,
    ),
    `Pools: ${poolEntries.length} gesehen, ${swapThresholds.map((entry) => `>=${entry.threshold} Swaps: ${entry.pools}`).join(", ")}`,
    `Pools mit Limit-Order-Aktivität: ${poolsWithLimitOrders}, Kandidaten mit variabler Fee-Rate: ${dynamicFeeCandidates}`,
    `Vollständiger Report: ${join(dataDir, "report.json")}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fehler bei der Auswertung: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
