import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgyCatalogModels, isAgyModel } from "./models.ts";
import { createAgySessionRuntime } from "./agy-adapter.ts";

async function runIntegrationTest() {
  console.log("=================================================");
  console.log("   AGY Provider & Subagent Adapter Test          ");
  console.log("=================================================\n");

  // 1. Check Model Catalog
  console.log("▶ [Step 1] Checking AGY Catalog Models...");
  const models = getAgyCatalogModels();
  console.log(`  Discovered ${models.length} AGY models:`);
  for (const m of models.slice(0, 5)) {
    console.log(`   - [${m.provider}] ${m.id} (${m.name})`);
  }
  assert.ok(models.length > 0, "Models list must not be empty");
  assert.ok(models.some((m) => m.id.includes("gemini-3.8") || m.id.includes("gemini-3.7")));
  assert.strictEqual(isAgyModel("agy"), true);
  assert.strictEqual(isAgyModel("openai"), false);
  console.log("  ✅ Step 1 PASSED: AGY provider models verified.\n");

  // 2. Check createAgySessionRuntime in an isolated workspace
  console.log("▶ [Step 2] Testing createAgySessionRuntime with tool events...");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-adapter-test-"));
  const sampleFile = path.join(tempDir, "greeting.txt");
  fs.writeFileSync(sampleFile, "Hello World\n", "utf8");

  try {
    const eventsEmitted: string[] = [];
    const runtime = await createAgySessionRuntime({
      taskId: "test-task-1",
      role: "developer" as any,
      effectiveCwd: tempDir,
      effectiveContext: {
        runtime: {
          model: {
            provider: "agy",
            modelId: "gemini-3.8-flash-low",
          },
        },
      } as any,
      modelRuntime: {} as any,
    });

    assert.strictEqual(runtime.resolvedModelDetails.provider, "agy");
    assert.strictEqual(runtime.resolvedModelDetails.id, "gemini-3.8-flash-low");

    runtime.session.subscribe((ev) => {
      eventsEmitted.push(ev.type);
      if (ev.type === "tool_execution_start") {
        console.log(`   [Event] tool_execution_start: ${ev.toolName}`);
      } else if (ev.type === "tool_execution_end") {
        console.log(`   [Event] tool_execution_end: ${ev.toolName}`);
      }
    });

    console.log("  Calling session.prompt()...");
    await runtime.session.prompt(
      "Read greeting.txt and append 'Verified by AGY adapter' to it.",
    );

    console.log(`  Events emitted: ${[...new Set(eventsEmitted)].join(", ")}`);
    assert.ok(eventsEmitted.includes("turn_start"));
    assert.ok(eventsEmitted.includes("message_end"));
    assert.ok(eventsEmitted.includes("agent_end"));

    const content = fs.readFileSync(sampleFile, "utf8");
    console.log(`  Updated file content:\n---\n${content.trim()}\n---`);
    assert.ok(content.includes("Verified by AGY adapter"));

    console.log("  ✅ Step 2 PASSED: AgySession executed cleanly and mutated file.\n");
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  console.log("=================================================");
  console.log("   🎉 ALL ADAPTER TESTS PASSED!                  ");
  console.log("=================================================");
}

runIntegrationTest().catch((err) => {
  console.error("Integration test error:", err);
  process.exit(1);
});
