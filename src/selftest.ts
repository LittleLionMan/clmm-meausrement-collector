import assert from "node:assert/strict";
import { getAddressEncoder, address } from "@solana/kit";
import {
  decodeLeadingPool,
  decodeLiquidityChangeEvent,
  decodeSwapEvent,
  eventDiscriminator,
  identifyEvent,
  impliedFeePpm,
  isLimitOrderEvent,
  isSwapEventPlausible,
  tickFromSqrtPriceX64,
} from "./events.js";
import { isSwapInstruction, parseProgramLogs } from "./logParser.js";

const PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const OTHER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const POOL = address("8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj");
const addressEncoder = getAddressEncoder();

function u128(value: bigint): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.writeBigUInt64LE(value & ((1n << 64n) - 1n), 0);
  buffer.writeBigUInt64LE(value >> 64n, 8);
  return buffer;
}

function u64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

function i32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}

function swapPayload(tick: number, withTradeFee: boolean): Buffer {
  const sqrtPrice =
    BigInt(Math.floor(Math.sqrt(1.0001 ** (tick + 0.5)) * 2 ** 32)) << 32n;
  const parts = [
    Buffer.from(addressEncoder.encode(POOL)),
    Buffer.alloc(96, 7),
    u64(1_000_000n),
    u64(0n),
    u64(995_000n),
    u64(0n),
    Buffer.from([1]),
    u128(sqrtPrice),
    u128(123_456_789n),
    i32(tick),
  ];
  if (withTradeFee) {
    parts.push(u64(2_500n), u64(0n));
  }
  return Buffer.concat(parts);
}

function eventBase64(name: string, payload: Buffer): string {
  return Buffer.concat([eventDiscriminator(name), payload]).toString("base64");
}

const swapData = eventBase64("SwapEvent", swapPayload(-20_000, true));
const liquidityData = eventBase64(
  "LiquidityChangeEvent",
  Buffer.concat([
    Buffer.from(addressEncoder.encode(POOL)),
    i32(-20_000),
    i32(-20_060),
    i32(-19_940),
    u128(10n),
    u128(20n),
  ]),
);

const logs = [
  `Program ${OTHER} invoke [1]`,
  "Program log: Instruction: Route",
  `Program ${PROGRAM} invoke [2]`,
  "Program log: Instruction: SwapV2",
  `Program data: ${swapData}`,
  `Program ${PROGRAM} consumed 50000 of 200000 compute units`,
  `Program ${PROGRAM} success`,
  `Program data: ${eventBase64("SomeRouterEvent", Buffer.alloc(10))}`,
  `Program ${OTHER} success`,
  `Program ${PROGRAM} invoke [1]`,
  "Program log: Instruction: IncreaseLiquidityV2",
  `Program data: ${liquidityData}`,
  `Program ${PROGRAM} success`,
];

const parsed = parseProgramLogs(logs, PROGRAM);
assert.equal(parsed.programInvoked, true);
assert.equal(parsed.truncated, false);
assert.deepEqual(parsed.instructions, ["SwapV2", "IncreaseLiquidityV2"]);
assert.equal(parsed.eventData.length, 2);
assert.equal(isSwapInstruction("SwapV2"), true);
assert.equal(isSwapInstruction("IncreaseLiquidityV2"), false);

const truncated = parseProgramLogs(
  [`Program ${PROGRAM} invoke [1]`, "Log truncated"],
  PROGRAM,
);
assert.equal(truncated.truncated, true);

const notInvoked = parseProgramLogs(
  [
    `Program ${OTHER} invoke [1]`,
    `Program data: ${swapData}`,
    `Program ${OTHER} success`,
  ],
  PROGRAM,
);
assert.equal(notInvoked.programInvoked, false);
assert.equal(notInvoked.eventData.length, 0);

const swapEvent = identifyEvent(parsed.eventData[0] ?? "");
assert.ok(swapEvent);
assert.equal(swapEvent.name, "SwapEvent");
assert.equal(swapEvent.payload.length, 213);
const swap = decodeSwapEvent(swapEvent.payload);
assert.ok(swap);
assert.equal(swap.pool, POOL);
assert.equal(swap.amount0, 1_000_000n);
assert.equal(swap.zeroForOne, true);
assert.equal(swap.tick, -20_000);
assert.equal(swap.tradeFee0, 2_500n);
assert.equal(isSwapEventPlausible(swap), true);
assert.equal(
  Math.abs(tickFromSqrtPriceX64(swap.sqrtPriceX64) - -20_000) <= 1,
  true,
);
assert.equal(impliedFeePpm(swap, 1_000n), 2_500);

const legacy = decodeSwapEvent(swapPayload(500, false));
assert.ok(legacy);
assert.equal(legacy.tradeFee0, null);
assert.equal(decodeSwapEvent(Buffer.alloc(100)), null);
assert.equal(isSwapEventPlausible({ ...swap, tick: 5 }), false);

const liquidityEvent = identifyEvent(parsed.eventData[1] ?? "");
assert.ok(liquidityEvent);
assert.equal(liquidityEvent.name, "LiquidityChangeEvent");
const change = decodeLiquidityChangeEvent(liquidityEvent.payload);
assert.ok(change);
assert.equal(change.tickLower, -20_060);
assert.equal(change.liquidityAfter, 20n);

assert.equal(
  identifyEvent(eventBase64("NotAnEvent", Buffer.alloc(4)))?.name,
  "Unknown",
);
assert.equal(isLimitOrderEvent("OpenLimitOrderEvent"), true);
assert.equal(isLimitOrderEvent("SwapEvent"), false);
assert.equal(
  decodeLeadingPool(
    Buffer.concat([Buffer.from(addressEncoder.encode(POOL)), Buffer.alloc(20)]),
  ),
  POOL,
);

process.stdout.write(
  `Selbsttest bestanden. SwapEvent-Diskriminator: ${eventDiscriminator("SwapEvent").toString("hex")}\n`,
);
