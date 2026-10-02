import { address, type Address } from "@solana/kit";

export interface EndpointConfig {
  readonly name: string;
  readonly httpUrl: string;
  readonly wsUrl: string;
}

export interface CollectorConfig {
  readonly programId: Address;
  readonly endpoints: readonly EndpointConfig[];
  readonly dataDir: string;
  readonly durationMs: number;
  readonly statsIntervalMs: number;
  readonly coverageIntervalMs: number;
  readonly poolSnapshotIntervalMs: number;
  readonly staleAfterMs: number;
  readonly seenRetentionMs: number;
  readonly coverageMinAgeSlots: bigint;
}

const CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const DEFAULT_ENDPOINTS =
  "public|https://api.mainnet-beta.solana.com|wss://api.mainnet-beta.solana.com";

function parseEndpoints(raw: string): EndpointConfig[] {
  const endpoints = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [name, httpUrl, wsUrl] = entry.split("|");
      if (!name || !httpUrl || !wsUrl) {
        throw new Error(
          `Ungültiger Endpoint-Eintrag (erwartet name|httpUrl|wsUrl): ${entry}`,
        );
      }
      return { name, httpUrl, wsUrl };
    });
  if (endpoints.length === 0) {
    throw new Error("Mindestens ein Endpoint muss konfiguriert sein.");
  }
  if (endpoints.length > 30) {
    throw new Error("Maximal 30 Endpoints werden unterstützt.");
  }
  return endpoints;
}

function parsePositiveNumber(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} muss eine positive Zahl sein, erhalten: ${raw}`);
  }
  return value;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): CollectorConfig {
  const durationHours = parsePositiveNumber(
    env["DURATION_HOURS"],
    48,
    "DURATION_HOURS",
  );
  return {
    programId: address(CLMM_PROGRAM_ID),
    endpoints: parseEndpoints(env["COLLECTOR_ENDPOINTS"] ?? DEFAULT_ENDPOINTS),
    dataDir: env["DATA_DIR"] ?? "./data",
    durationMs: durationHours * 3_600_000,
    statsIntervalMs: 60_000,
    coverageIntervalMs: 60_000,
    poolSnapshotIntervalMs: 600_000,
    staleAfterMs: 60_000,
    seenRetentionMs: 15 * 60_000,
    coverageMinAgeSlots: 75n,
  };
}
