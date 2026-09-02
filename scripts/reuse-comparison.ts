/**
 * Real short-task comparison: cold spawn vs continue_subagent reuse.
 * Run: npx tsx scripts/reuse-comparison.ts
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RoleRegistry } from "../server/contracts/index.ts";
import { SubagentManager, subagentTasks } from "../server/subagent-manager.ts";
import type { UISubagentTask } from "../shared/protocol.ts";

const PROVIDER = process.env.REUSE_COMPARE_PROVIDER || "minimax-custom";
const MODEL_ID = process.env.REUSE_COMPARE_MODEL || "MiniMax-M2.7";
const TASK_TIMEOUT_MS = Number(process.env.REUSE_COMPARE_TIMEOUT_MS || 240_000);

function countToolCalls(task: UISubagentTask): number {
  let n = 0;
  for (const msg of task.messages ?? []) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === "toolCall") n++;
    }
  }
  return n;
}

function countExplorationToolCalls(task: UISubagentTask): number {
  let n = 0;
  for (const msg of task.messages ?? []) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type !== "toolCall") continue;
      const args = b.args as { command?: string; path?: string } | undefined;
      const cmd = String(args?.command || args?.path || b.name || "").toLowerCase();
      if (
        /\b(ls|pwd|which|find|locate|type |command -v|python --version|pytest --version|node -v|npm -v|conda|env)\b/.test(
          cmd,
        ) ||
        b.name === "ls" ||
        b.name === "find"
      ) {
        n++;
      }
    }
  }
  return n;
}

async function waitForCompletion(
  manager: SubagentManager,
  taskId: string,
  timeoutMs: number,
): Promise<UISubagentTask> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inst = subagentTasks.get(taskId);
    if (!inst) throw new Error(`task missing: ${taskId}`);
    const status = inst.task.status;
    if (
      status === "completed" ||
      status === "failed" ||
      status === "incomplete" ||
      status === "aborted" ||
      status === "conflict"
    ) {
      return inst.task;
    }
    // Real sessions emit agent_end -> handleSubagentCompletion
    await new Promise((r) => setTimeout(r, 1000));
  }
  const task = subagentTasks.get(taskId)?.task;
  throw new Error(
    `Timeout waiting for task ${taskId}. last status=${task?.status} tools=${task ? countToolCalls(task) : 0}`,
  );
}

function setupFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-reuse-compare-"));
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Reuse Compare"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "reuse@test.local"]);
  writeFileSync(
    join(dir, ".gitignore"),
    ".worktrees\n.worktrees/\n__pycache__/\n.pytest_cache/\n",
  );
  writeFileSync(
    join(dir, "README.md"),
    `# Env Probe Fixture

Misleading note: some docs mention /opt/does-not-exist/bin/python — ignore dead paths.
`,
  );
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "ENV.md"),
    `# Environment

Use the system \`python3\` and \`pytest\` available on PATH.
Do NOT use /opt/does-not-exist/bin/python (it does not exist).
Evidence notes should go under docs/evidence/.
`,
  );
  mkdirSync(join(dir, "docs", "evidence"), { recursive: true });
  writeFileSync(join(dir, "docs", "evidence", ".gitkeep"), "");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "scripts", "probe.sh"),
    `#!/bin/sh
echo "probe_ok"
command -v python3
python3 --version
command -v pytest || true
`,
  );
  execFileSync("chmod", ["+x", join(dir, "scripts", "probe.sh")]);
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "fixture"]);
  return dir;
}

async function main() {
  RoleRegistry.getInstance().reload();
  const agentDir = mkdtempSync(join(tmpdir(), "pi-reuse-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  // Reuse host auth/models if present
  const homeAgent = join(process.env.HOME || "", ".pi", "agent");
  if (existsSync(join(homeAgent, "auth.json"))) {
    writeFileSync(join(agentDir, "auth.json"), readFileSync(join(homeAgent, "auth.json")));
  }
  if (existsSync(join(homeAgent, "models.json"))) {
    writeFileSync(join(agentDir, "models.json"), readFileSync(join(homeAgent, "models.json")));
  }

  const repo = setupFixtureRepo();
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: true });
  const manager = new SubagentManager(modelRuntime);
  const parentModel = { provider: PROVIDER, id: MODEL_ID };
  const parentSessionId = `compare-${Date.now()}`;

  const promptA = [
    "Discover the working Python interpreter and pytest for this repository.",
    "Write docs/evidence/env-a.md containing:",
    "- exact python path/command",
    "- python version",
    "- pytest availability/version (or note if missing)",
    "- any dead paths you confirmed do NOT work",
    "Do not modify production source beyond docs/evidence/env-a.md.",
    "Finish quickly after writing the evidence file.",
  ].join("\n");

  const promptB = [
    "Confirm the same Python/pytest environment still works.",
    "Write docs/evidence/env-b.md with python/pytest versions.",
    "Prefer already-known environment facts; avoid re-exploring the whole repo if possible.",
    "Do not modify files outside docs/evidence/env-b.md.",
    "Finish quickly after writing the evidence file.",
  ].join("\n");

  console.log(`Using model ${PROVIDER}/${MODEL_ID}`);
  console.log(`Repo: ${repo}`);

  // --- Cold Task A ---
  const tA0 = Date.now();
  const taskA = await manager.spawn({
    parentSessionId,
    role: "tester",
    taskTitle: "Spike-env-A cold discovery",
    taskPrompt: promptA,
    parentCwd: repo,
    parentModel,
    taskContract: {
      taskId: `task-a-${Date.now()}`,
      parentSessionId,
      role: "tester",
      goal: "Discover python/pytest and write env-a.md",
      scope: { include: ["docs/evidence/**"], exclude: [] },
      acceptanceCriteria: ["docs/evidence/env-a.md exists with python version"],
      expectedEffects: ["artifact"],
    },
    executionOptions: {
      model: { provider: PROVIDER, modelId: MODEL_ID, thinkingLevel: "low" },
      timeoutMs: TASK_TIMEOUT_MS,
    },
  });
  console.log(`Task A started: ${taskA.taskId} agent=${taskA.agentId}`);
  const doneA = await waitForCompletion(manager, taskA.taskId, TASK_TIMEOUT_MS);
  const durA = Date.now() - tA0;
  console.log(
    `Task A done status=${doneA.status} tools=${countToolCalls(doneA)} explore=${countExplorationToolCalls(doneA)} durMs=${durA}`,
  );
  if (doneA.status !== "completed") {
    throw new Error(`Task A did not complete: ${doneA.status} ${doneA.error || ""}`);
  }

  const agentId = doneA.agentId!;
  const reusable = manager.listReusableAgentSummaries(parentSessionId).find((a) => a.agentId === agentId);
  console.log("Reusable after A:", JSON.stringify(reusable, null, 2));

  // --- Continue Task B (reuse) ---
  const tB0 = Date.now();
  const taskB = await manager.continueAgent({
    agentId,
    parentSessionId,
    taskTitle: "Spike-env-B reuse",
    taskPrompt: promptB,
    parentCwd: repo,
    parentModel,
    taskContract: {
      taskId: `task-b-reuse-${Date.now()}`,
      parentSessionId,
      role: "tester",
      goal: "Confirm env and write env-b.md with minimal rediscovery",
      scope: { include: ["docs/evidence/**"], exclude: [] },
      acceptanceCriteria: ["docs/evidence/env-b.md exists"],
      expectedEffects: ["artifact"],
    },
    executionOptions: {
      model: { provider: PROVIDER, modelId: MODEL_ID, thinkingLevel: "low" },
      timeoutMs: TASK_TIMEOUT_MS,
    },
  });
  console.log(`Task B (reuse) started: ${taskB.taskId}`);
  const doneB = await waitForCompletion(manager, taskB.taskId, TASK_TIMEOUT_MS);
  const durB = Date.now() - tB0;
  console.log(
    `Task B reuse done status=${doneB.status} tools=${countToolCalls(doneB)} explore=${countExplorationToolCalls(doneB)} durMs=${durB}`,
  );

  // --- Cold Task B' (fresh spawn, same prompt) ---
  const parentSessionCold = `${parentSessionId}-cold`;
  const tC0 = Date.now();
  const taskC = await manager.spawn({
    parentSessionId: parentSessionCold,
    role: "tester",
    taskTitle: "Spike-env-B cold",
    taskPrompt: promptB,
    parentCwd: repo,
    parentModel,
    taskContract: {
      taskId: `task-b-cold-${Date.now()}`,
      parentSessionId: parentSessionCold,
      role: "tester",
      goal: "Confirm env and write env-b.md from scratch",
      scope: { include: ["docs/evidence/**"], exclude: [] },
      acceptanceCriteria: ["docs/evidence/env-b.md exists"],
      expectedEffects: ["artifact"],
    },
    executionOptions: {
      model: { provider: PROVIDER, modelId: MODEL_ID, thinkingLevel: "low" },
      timeoutMs: TASK_TIMEOUT_MS,
    },
  });
  console.log(`Task B cold started: ${taskC.taskId}`);
  const doneC = await waitForCompletion(manager, taskC.taskId, TASK_TIMEOUT_MS);
  const durC = Date.now() - tC0;
  console.log(
    `Task B cold done status=${doneC.status} tools=${countToolCalls(doneC)} explore=${countExplorationToolCalls(doneC)} durMs=${durC}`,
  );

  const summary = {
    model: `${PROVIDER}/${MODEL_ID}`,
    taskA_cold_discovery: {
      taskId: doneA.taskId,
      status: doneA.status,
      toolCalls: countToolCalls(doneA),
      explorationToolCalls: countExplorationToolCalls(doneA),
      durationMs: durA,
    },
    taskB_reuse_continue: {
      taskId: doneB.taskId,
      agentId,
      status: doneB.status,
      toolCalls: countToolCalls(doneB),
      explorationToolCalls: countExplorationToolCalls(doneB),
      durationMs: durB,
      promptHasKnowledge: (doneB.taskPrompt || "").includes("Reusable Knowledge"),
    },
    taskB_cold_spawn: {
      taskId: doneC.taskId,
      status: doneC.status,
      toolCalls: countToolCalls(doneC),
      explorationToolCalls: countExplorationToolCalls(doneC),
      durationMs: durC,
    },
    delta_reuse_vs_cold: {
      toolCallsSaved: countToolCalls(doneC) - countToolCalls(doneB),
      explorationSaved: countExplorationToolCalls(doneC) - countExplorationToolCalls(doneB),
      durationMsSaved: durC - durB,
    },
  };

  const outPath = join(process.cwd(), "docs", "reuse-comparison-result.json");
  mkdirSync(join(process.cwd(), "docs"), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log("\n=== COMPARISON SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${outPath}`);

  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
