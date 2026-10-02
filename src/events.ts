import { createHash } from "node:crypto";
import { getAddressDecoder, type Address } from "@solana/kit";

export const EVENT_NAMES = [
  "PoolCreatedEvent",
  "CollectProtocolFeeEvent",
  "SwapEvent",
  "LiquidityChangeEvent",
  "ConfigChangeEvent",
  "CreatePersonalPositionEvent",
  "IncreaseLiquidityEvent",
  "DecreaseLiquidityEvent",
  "LiquidityCalculateEvent",
  "CollectPersonalFeeEvent",
  "UpdateRewardInfosEvent",
  "OpenLimitOrderEvent",
  "IncreaseLimitOrderEvent",
  "SettleLimitOrderEvent",
  "DecreaseLimitOrderEvent",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export function eventDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

const NAME_BY_DISCRIMINATOR: ReadonlyMap<string, EventName> = new Map(
  EVENT_NAMES.map((name) => [eventDiscriminator(name).toString("hex"), name]),
);

export interface IdentifiedEvent {
  readonly name: EventName | "Unknown";
  readonly discriminator: string;
  readonly payload: Buffer;
  readonly dataBase64: string;
}

export function identifyEvent(dataBase64: string): IdentifiedEvent | null {
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length < 8) {
    return null;
  }
  const discriminator = bytes.subarray(0, 8).toString("hex");
  return {
    name: NAME_BY_DISCRIMINATOR.get(discriminator) ?? "Unknown",
    discriminator,
    payload: bytes.subarray(8),
    dataBase64,
  };
}

export const SWAP_EVENT_LENGTH_WITH_TRADE_FEE = 213;
export const SWAP_EVENT_LENGTH_LEGACY = 197;
export const LIQUIDITY_CHANGE_EVENT_LENGTH = 76;

export interface SwapEventData {
  readonly pool: Address;
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly zeroForOne: boolean;
  readonly sqrtPriceX64: bigint;
  readonly liquidity: bigint;
  readonly tick: number;
  readonly tradeFee0: bigint | null;
  readonly tradeFee1: bigint | null;
}

export interface LiquidityChangeEventData {
  readonly pool: Address;
  readonly tick: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidityBefore: bigint;
  readonly liquidityAfter: bigint;
}

const addressDecoder = getAddressDecoder();

function readAddress(payload: Buffer, offset: number): Address {
  return addressDecoder.decode(payload.subarray(offset, offset + 32));
}

function readU128(payload: Buffer, offset: number): bigint {
  const low = payload.readBigUInt64LE(offset);
  const high = payload.readBigUInt64LE(offset + 8);
  return (high << 64n) | low;
}

const LIMIT_ORDER_EVENTS: ReadonlySet<EventName> = new Set([
  "OpenLimitOrderEvent",
  "IncreaseLimitOrderEvent",
  "SettleLimitOrderEvent",
  "DecreaseLimitOrderEvent",
]);

export function isLimitOrderEvent(
  name: EventName | "Unknown",
): name is EventName {
  return name !== "Unknown" && LIMIT_ORDER_EVENTS.has(name);
}

export function decodeLeadingPool(payload: Buffer): Address | null {
  return payload.length >= 32 ? readAddress(payload, 0) : null;
}

export function decodeSwapEvent(payload: Buffer): SwapEventData | null {
  const hasTradeFee = payload.length === SWAP_EVENT_LENGTH_WITH_TRADE_FEE;
  if (!hasTradeFee && payload.length !== SWAP_EVENT_LENGTH_LEGACY) {
    return null;
  }
  return {
    pool: readAddress(payload, 0),
    amount0: payload.readBigUInt64LE(128),
    amount1: payload.readBigUInt64LE(144),
    zeroForOne: payload.readUInt8(160) === 1,
    sqrtPriceX64: readU128(payload, 161),
    liquidity: readU128(payload, 177),
    tick: payload.readInt32LE(193),
    tradeFee0: hasTradeFee ? payload.readBigUInt64LE(197) : null,
    tradeFee1: hasTradeFee ? payload.readBigUInt64LE(205) : null,
  };
}

export function decodeLiquidityChangeEvent(
  payload: Buffer,
): LiquidityChangeEventData | null {
  if (payload.length !== LIQUIDITY_CHANGE_EVENT_LENGTH) {
    return null;
  }
  return {
    pool: readAddress(payload, 0),
    tick: payload.readInt32LE(32),
    tickLower: payload.readInt32LE(36),
    tickUpper: payload.readInt32LE(40),
    liquidityBefore: readU128(payload, 44),
    liquidityAfter: readU128(payload, 60),
  };
}

const Q64 = 2 ** 64;
const LOG_TICK_BASE = Math.log(1.0001);

export function tickFromSqrtPriceX64(sqrtPriceX64: bigint): number {
  const sqrtPrice = Number(sqrtPriceX64) / Q64;
  return Math.floor((2 * Math.log(sqrtPrice)) / LOG_TICK_BASE);
}

export function isSwapEventPlausible(event: SwapEventData): boolean {
  if (event.sqrtPriceX64 === 0n) {
    return false;
  }
  return Math.abs(tickFromSqrtPriceX64(event.sqrtPriceX64) - event.tick) <= 1;
}

export function isLiquidityChangeEventPlausible(
  event: LiquidityChangeEventData,
): boolean {
  return event.tickLower < event.tickUpper;
}

export function impliedFeePpm(
  event: SwapEventData,
  minimumFee: bigint,
): number | null {
  if (event.tradeFee0 === null || event.tradeFee1 === null) {
    return null;
  }
  const feeOnToken0 = event.tradeFee0 > 0n;
  const fee = feeOnToken0 ? event.tradeFee0 : event.tradeFee1;
  if (fee < minimumFee) {
    return null;
  }
  const amount = feeOnToken0 ? event.amount0 : event.amount1;
  const feeIsOnInputSide = feeOnToken0 === event.zeroForOne;
  const grossAmount = feeIsOnInputSide ? amount : amount + fee;
  if (grossAmount === 0n) {
    return null;
  }
  return Number((fee * 1_000_000_000n) / grossAmount) / 1000;
}
