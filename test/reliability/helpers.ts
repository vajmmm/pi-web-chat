import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoleRegistry } from "../../server/contracts/index.ts";

export const testAgentDir = mkdtempSync(join(tmpdir(), "pi-reliability-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

export const mockModelRuntime = { getModel: () => null } as any;

export function createMockSession(messages: any[] = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }]) {
  const subscribers: ((event: any) => void)[] = [];
  const normalizedMessages = messages.length > 0 ? messages.map((m) => {
    if (m && m.role === "assistant" && m.stopReason === undefined && m.rawStopReason === undefined) {
      return { stopReason: "stop", ...m };
    }
    return m;
  }) : [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }];

  return {
    messages: normalizedMessages,
    subscribe: (fn: (event: any) => void) => {
      subscribers.push(fn);
    },
    prompt: async () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    setActiveToolsByName: () => {},
    model: { provider: "mock", id: "mock-model", name: "Mock Model" },
    emit: (event: any) => {
      const promises: unknown[] = [];
      for (const s of subscribers) {
        promises.push(s(event));
      }
      return Promise.all(promises);
    },
  };
}

export function setupTestGitRepo(): { gitRepoDir: string; cleanup: () => void } {
  RoleRegistry.getInstance().reload();

  const gitRepoDir = mkdtempSync(join(tmpdir(), "pi-git-repo-test-"));
  execFileSync("git", ["init", "-b", "main", gitRepoDir]);
  execFileSync("git", ["-C", gitRepoDir, "config", "user.name", "Test Agent"]);
  execFileSync("git", ["-C", gitRepoDir, "config", "user.email", "agent@test.com"]);

  writeFileSync(join(gitRepoDir, ".gitignore"), ".worktrees\n.worktrees/\n");
  writeFileSync(join(gitRepoDir, "README.md"), "# Initial Project\n");
  writeFileSync(join(gitRepoDir, "main.ts"), "export const value = 1;\n");
  execFileSync("git", ["-C", gitRepoDir, "add", "."]);
  execFileSync("git", ["-C", gitRepoDir, "commit", "-m", "Initial commit"]);

  return {
    gitRepoDir,
    cleanup: () => {
      try {
        rmSync(gitRepoDir, { recursive: true, force: true });
      } catch {}
    },
  };
}
