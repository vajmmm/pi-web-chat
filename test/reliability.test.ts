import { after, before, describe } from "node:test";
import { RoleRegistry } from "../server/contracts/index.ts";
import { setupTestGitRepo, testAgentDir } from "./reliability/helpers.ts";
import { rmSync } from "node:fs";

import { registerWorktreeLifecycleTests } from "./reliability/worktree-lifecycle.test.ts";
import { registerSubagentLifecycleTests } from "./reliability/subagent-lifecycle.test.ts";
import { registerIntegrationWorkspaceTests } from "./reliability/integration-workspace.test.ts";
import { registerVerificationEvidenceTests } from "./reliability/verification-evidence.test.ts";
import { registerFinalizeGatesMutationTests } from "./reliability/finalize-gates-mutation.test.ts";
import { registerFinalizeRollbackTests } from "./reliability/finalize-rollback.test.ts";
import { registerRuntimeResourcesTests } from "./reliability/runtime-resources.test.ts";
import { registerTaskLineageFinalizeTests } from "./reliability/task-lineage-finalize.test.ts";
import { registerTaskStateMachineFixesTests } from "./reliability/task-state-machine-fixes.test.ts";
import "./reliability/subagent-event-lifecycle.test.ts";

describe("Multi-Agent Orchestration Reliability Tests", () => {
  let repo: { gitRepoDir: string; cleanup: () => void };

  before(() => {
    repo = setupTestGitRepo();
  });

  after(() => {
    try {
      rmSync(testAgentDir, { recursive: true, force: true });
    } catch {}
    repo.cleanup();
  });

  registerWorktreeLifecycleTests(() => repo.gitRepoDir);
  registerSubagentLifecycleTests(() => repo.gitRepoDir);
  registerIntegrationWorkspaceTests(() => repo.gitRepoDir);
  registerVerificationEvidenceTests(() => repo.gitRepoDir);
  registerFinalizeGatesMutationTests(() => repo.gitRepoDir);
  registerFinalizeRollbackTests(() => repo.gitRepoDir);
  registerRuntimeResourcesTests(() => repo.gitRepoDir);
  registerTaskLineageFinalizeTests(() => repo.gitRepoDir);
  registerTaskStateMachineFixesTests(() => repo.gitRepoDir);
});
