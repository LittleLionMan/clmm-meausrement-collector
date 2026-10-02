export interface ParsedProgramLogs {
  readonly programInvoked: boolean;
  readonly truncated: boolean;
  readonly instructions: readonly string[];
  readonly eventData: readonly string[];
}

const INVOKE_PATTERN = /^Program (\w+) invoke \[\d+\]$/;
const EXIT_PATTERN = /^Program (\w+) (?:success|failed)/;
const DATA_PREFIX = "Program data: ";
const INSTRUCTION_PREFIX = "Program log: Instruction: ";
const TRUNCATION_MARKER = "Log truncated";

export function parseProgramLogs(
  logs: readonly string[],
  programId: string,
): ParsedProgramLogs {
  const stack: string[] = [];
  const instructions: string[] = [];
  const eventData: string[] = [];
  let programInvoked = false;
  let truncated = false;

  for (const line of logs) {
    if (line.startsWith(TRUNCATION_MARKER)) {
      truncated = true;
      continue;
    }
    const invoke = INVOKE_PATTERN.exec(line);
    if (invoke?.[1] !== undefined) {
      stack.push(invoke[1]);
      if (invoke[1] === programId) {
        programInvoked = true;
      }
      continue;
    }
    const exit = EXIT_PATTERN.exec(line);
    if (exit?.[1] !== undefined) {
      if (stack.at(-1) === exit[1]) {
        stack.pop();
      }
      continue;
    }
    if (stack.at(-1) !== programId) {
      continue;
    }
    if (line.startsWith(DATA_PREFIX)) {
      for (const chunk of line.slice(DATA_PREFIX.length).split(" ")) {
        if (chunk.length > 0) {
          eventData.push(chunk);
        }
      }
      continue;
    }
    if (line.startsWith(INSTRUCTION_PREFIX)) {
      instructions.push(line.slice(INSTRUCTION_PREFIX.length).trim());
    }
  }

  return { programInvoked, truncated, instructions, eventData };
}

export function isSwapInstruction(name: string): boolean {
  return name === "Swap" || name === "SwapV2" || name === "SwapRouterBaseIn";
}
