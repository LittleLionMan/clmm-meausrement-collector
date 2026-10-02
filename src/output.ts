import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";

export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeJsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await writeFile(path, `${toJson(value)}\n`, "utf8");
}

export class NdjsonWriter {
  private stream: WriteStream | null = null;
  private currentKey = "";
  private pendingBytes = 0;

  constructor(
    private readonly directory: string,
    private readonly prefix: string,
    private readonly rotateHourly: boolean,
  ) {}

  write(record: unknown): void {
    const key = this.rotateHourly
      ? new Date().toISOString().slice(0, 13)
      : "all";
    if (this.stream === null || key !== this.currentKey) {
      this.stream?.end();
      const fileName = this.rotateHourly
        ? `${this.prefix}-${key}.ndjson`
        : `${this.prefix}.ndjson`;
      this.stream = createWriteStream(join(this.directory, fileName), {
        flags: "a",
      });
      this.currentKey = key;
    }
    const line = `${toJson(record)}\n`;
    this.pendingBytes += Buffer.byteLength(line);
    this.stream.write(line);
  }

  takeWrittenBytes(): number {
    const bytes = this.pendingBytes;
    this.pendingBytes = 0;
    return bytes;
  }

  async close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (stream !== null) {
      stream.end();
      await finished(stream);
    }
  }
}
