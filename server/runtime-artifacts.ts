import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  lstatSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ArtifactPointer {
  artifactRef: string;
  runtimePath: string;
}

export interface PersistedToolOutput extends ArtifactPointer {
  rawBytes: number;
  completeness: "complete" | "preview_only";
  source: "pi_full_output" | "tool_result";
}

export interface ToolExecutionFact {
  toolCallId: string;
  toolName: string;
  timestamp: string;
  isError: boolean;
  exitCode?: number;
  artifactRef?: string;
  runtimePath?: string;
  rawBytes: number;
  completeness: "complete" | "preview_only";
  input?: unknown;
}

function safeSegment(value: string): string {
  const trimmed = String(value || "unknown").trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe && safe !== "." && safe !== ".." ? safe : "unknown";
}

export function getHarnessRuntimeRoot(): string {
  return resolve(process.env.HARNESS_RUNTIME_ROOT || join(getAgentDir(), "harness-runtime"));
}

export function getTaskRuntimeDir(runId: string, taskId: string): string {
  const dir = taskRuntimePath(runId, taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function taskRuntimePath(runId: string, taskId: string): string {
  if (!runId || !taskId) throw new Error("Run and task IDs are required");
  return join(
    getHarnessRuntimeRoot(),
    "runs",
    safeSegment(runId),
    "tasks",
    safeSegment(taskId),
  );
}

export function initializeTaskFactStore(runId: string, taskId: string): void {
  const taskDir = getTaskRuntimeDir(runId, taskId);
  mkdirSync(join(taskDir, "tool_outputs"), { recursive: true });
  for (const name of ["transcript.jsonl", "tool-executions.jsonl"]) {
    const file = join(taskDir, name);
    if (!existsSync(file)) writeFileSync(file, "", "utf8");
  }
}

export function artifactRefFor(runId: string, taskId: string, relativePath: string): string {
  const clean = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(safeSegment)
    .join("/");
  return `artifacts://runs/${safeSegment(runId)}/${safeSegment(taskId)}/${clean}`;
}

export function resolveArtifactRef(ref: string): string | null {
  const match = /^artifacts:\/\/runs\/([^/]+)\/([^/]+)\/(.+)$/.exec(ref);
  if (!match || match[1] !== safeSegment(match[1]) || match[2] !== safeSegment(match[2])) return null;
  if (match[3].split(/[\\/]/).some((part) => !part || part === "." || part === "..")) return null;
  const taskRoot = resolve(
    getHarnessRuntimeRoot(),
    "runs",
    safeSegment(match[1]),
    "tasks",
    safeSegment(match[2]),
  );
  const target = resolve(taskRoot, match[3]);
  const rel = relative(taskRoot, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  // Reject symlinks escaping the runtime root, including ancestors of missing files.
  let existing = target;
  while (!existsSync(existing) && existing !== dirname(existing)) existing = dirname(existing);
  if (existsSync(getHarnessRuntimeRoot())) {
    const physicalRelative = relative(realpathSync(getHarnessRuntimeRoot()), realpathSync(existing));
    if (physicalRelative === ".." || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) return null;
  }
  return target;
}

/** Live projections contain paths; immutable records retain only portable identities. */
export function artifactRuntimePointer(ref: string): { ref: string; runtimePath?: string } {
  const runtimePath = resolveArtifactRef(ref);
  return { ref, ...(runtimePath ? { runtimePath } : {}) };
}

export function removeTaskArtifacts(runId: string, taskId: string): void {
  const path = taskRuntimePath(runId, taskId);
  if (!existsSync(path)) return;
  const root = realpathSync(getHarnessRuntimeRoot());
  const parent = realpathSync(dirname(path));
  const rel = relative(root, parent);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Artifact cleanup target escapes runtime root");
  }
  // rm removes a target symlink itself; it must never traverse an ancestor symlink.
  rmSync(path, { recursive: !lstatSync(path).isSymbolicLink(), force: true });
}

function atomicWrite(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function textFromContent(content: readonly unknown[]): string {
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block) {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return JSON.stringify(block);
    })
    .join("\n");
}

function findFullOutputPath(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const direct = (details as { fullOutputPath?: unknown }).fullOutputPath;
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const value of Object.values(details as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      const nested = findFullOutputPath(value);
      if (nested) return nested;
    }
  }
  return undefined;
}

function extractExitCode(details: unknown): number | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as { exitCode?: unknown }).exitCode;
  return typeof value === "number" ? value : undefined;
}

/** Persist at the execution boundary. Projection callers must invoke this before truncation. */
export function persistToolOutput(options: {
  runId: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  content: readonly unknown[];
  details?: unknown;
  input?: unknown;
  isError?: boolean;
}): PersistedToolOutput {
  const taskDir = getTaskRuntimeDir(options.runId, options.taskId);
  const relativePath = join(
    "tool_outputs",
    `${safeSegment(options.toolCallId)}_${safeSegment(options.toolName)}.log`,
  );
  const runtimePath = join(taskDir, relativePath);
  mkdirSync(dirname(runtimePath), { recursive: true });

  const piFullOutputPath = findFullOutputPath(options.details);
  const raw = textFromContent(options.content);
  let source: PersistedToolOutput["source"] = "tool_result";
  let completeness: PersistedToolOutput["completeness"] = "complete";
  if (piFullOutputPath && existsSync(piFullOutputPath)) {
    copyFileSync(piFullOutputPath, runtimePath);
    source = "pi_full_output";
  } else {
    atomicWrite(runtimePath, raw);
    const truncation = options.details && typeof options.details === "object"
      ? (options.details as { truncation?: { truncated?: boolean } }).truncation
      : undefined;
    if (piFullOutputPath || truncation?.truncated || /\[Showing [^\n]*Full output:/.test(raw)) {
      completeness = "preview_only";
    }
  }

  const artifactRef = artifactRefFor(options.runId, options.taskId, relativePath);
  const rawBytes = statSync(runtimePath).size;
  const fact: ToolExecutionFact = {
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    timestamp: new Date().toISOString(),
    isError: Boolean(options.isError),
    exitCode: extractExitCode(options.details) ?? (options.toolName === "bash" && options.isError
      ? Number(/Command exited with code (\d+)\s*$/.exec(raw)?.[1]) || undefined
      : undefined),
    artifactRef,
    runtimePath,
    rawBytes,
    completeness,
    input: options.input,
  };
  appendFileSync(join(taskDir, "tool-executions.jsonl"), `${JSON.stringify(fact)}\n`, "utf8");
  return { artifactRef, runtimePath, rawBytes, completeness, source };
}

export function appendShadowTranscript(runId: string, taskId: string, entry: unknown): ArtifactPointer {
  const taskDir = getTaskRuntimeDir(runId, taskId);
  const runtimePath = join(taskDir, "transcript.jsonl");
  appendFileSync(runtimePath, `${JSON.stringify(entry)}\n`, "utf8");
  return {
    artifactRef: artifactRefFor(runId, taskId, "transcript.jsonl"),
    runtimePath,
  };
}

export function writeTaskArtifact(
  runId: string,
  taskId: string,
  relativePath: string,
  value: unknown,
  options?: { immutable?: boolean },
): ArtifactPointer {
  const taskDir = getTaskRuntimeDir(runId, taskId);
  const runtimePath = resolveArtifactRef(artifactRefFor(runId, taskId, relativePath));
  if (!runtimePath || relative(taskDir, runtimePath) !== relativePath) throw new Error("Invalid artifact path");
  if (!(options?.immutable && existsSync(runtimePath))) {
    atomicWrite(runtimePath, `${JSON.stringify(value, null, 2)}\n`);
  }
  return { artifactRef: artifactRefFor(runId, taskId, relativePath), runtimePath };
}

export function readTaskArtifact<T>(runId: string, taskId: string, name: string): T | null {
  const path = resolveArtifactRef(artifactRefFor(runId, taskId, name));
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readToolExecutionFacts(runId: string, taskId: string): ToolExecutionFact[] {
  const file = join(getTaskRuntimeDir(runId, taskId), "tool-executions.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ToolExecutionFact];
      } catch {
        return [];
      }
    });
}
