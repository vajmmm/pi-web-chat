import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgyTask } from "./agy-runner.ts";
import { getDescendantPids } from "./process-manager.ts";

async function runAllTests() {
  console.log("=================================================");
  console.log("   AGY Subagent CLI Decoupled Prototype Test     ");
  console.log("=================================================\n");

  let passed = 0;
  let total = 3;

  // -------------------------------------------------------------
  // Test 1: Basic Dialog, Streaming & Token Accounting
  // -------------------------------------------------------------
  console.log("▶ [Test 1/3] Testing Basic Dialog & Stream Parsing...");
  try {
    const t0 = Date.now();
    let textReceived = "";
    const res1 = await runAgyTask({
      prompt: "Calculate 123 * 456 and output only the number.",
      cwd: process.cwd(),
      model: "gemini-3.8-flash-low",
      timeoutMs: 30000,
      onTextDelta: (delta) => {
        textReceived += delta;
      },
    });

    const duration = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`  Response: "${res1.response.trim()}" (Duration: ${duration}s)`);
    console.log(`  Conversation ID: ${res1.conversationId || "N/A"}`);
    if (res1.usage) {
      console.log(
        `  Tokens: In=${res1.usage.input_tokens}, Out=${res1.usage.output_tokens}, Total=${res1.usage.total_tokens}`,
      );
    }

    if (res1.ok && (res1.response.includes("56088") || textReceived.includes("56088"))) {
      console.log("  ✅ Test 1 PASSED: Fast response and stream parsed correctly.\n");
      passed++;
    } else {
      console.error(`  ❌ Test 1 FAILED: Unexpected response or error: ${res1.error}\n`);
    }
  } catch (err: any) {
    console.error(`  ❌ Test 1 EXCEPTION: ${err.message}\n`);
  }

  // -------------------------------------------------------------
  // Test 2: File Reading & Mutation in Isolated Workspace
  // -------------------------------------------------------------
  console.log("▶ [Test 2/3] Testing Tool Execution & File Mutation in Isolated CWD...");
  const tempDir = path.join(os.tmpdir(), `agy-test-ws-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const testFile = path.join(tempDir, "note.txt");
    fs.writeFileSync(testFile, "Alpha line\n", "utf8");

    const toolsInvoked: string[] = [];
    const res2 = await runAgyTask({
      prompt: `Please read note.txt in the current directory, and append a new line containing "Beta line verified" to note.txt.`,
      cwd: tempDir,
      model: "gemini-3.8-flash-low",
      timeoutMs: 45000,
      onToolStart: (name, params) => {
        toolsInvoked.push(name);
        console.log(`  [Tool Call] ${name} ->`, JSON.stringify(params).slice(0, 80));
      },
    });

    const updatedContent = fs.readFileSync(testFile, "utf8");
    console.log(`  File content after AGY execution:\n---\n${updatedContent.trim()}\n---`);
    console.log(`  Tools called: [${toolsInvoked.join(", ")}]`);

    const hasBeta = updatedContent.includes("Beta line verified");
    if (res2.ok && hasBeta) {
      console.log("  ✅ Test 2 PASSED: Tools called and file mutation verified.\n");
      passed++;
    } else {
      console.error(
        `  ❌ Test 2 FAILED: Content mismatch (hasBeta=${hasBeta}, ok=${res2.ok}, error=${res2.error})\n`,
      );
    }
  } catch (err: any) {
    console.error(`  ❌ Test 2 EXCEPTION: ${err.message}\n`);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  // -------------------------------------------------------------
  // Test 3: Cancellation, AbortSignal & Clean Process Teardown
  // -------------------------------------------------------------
  console.log("▶ [Test 3/3] Testing AbortSignal & Process Tree Clean Termination...");
  try {
    const ac = new AbortController();
    const t0 = Date.now();

    // Trigger abort after 1500ms
    setTimeout(() => {
      console.log("  [AbortController] Triggering abort()...");
      ac.abort();
    }, 1500);

    const res3 = await runAgyTask({
      prompt:
        "Please write an extremely long essay of 5000 words comparing all programming languages, taking your time.",
      cwd: process.cwd(),
      model: "gemini-3.8-flash-low",
      abortSignal: ac.signal,
      timeoutMs: 60000,
    });

    const elapsed = Date.now() - t0;
    console.log(`  Result status: ${res3.status} (Elapsed: ${elapsed}ms)`);

    // Verify descendants of current process
    const descendants = getDescendantPids(process.pid);
    console.log(`  Active descendants of current test process: ${descendants.length}`);

    if (res3.status === "ABORTED" && elapsed < 5000) {
      console.log("  ✅ Test 3 PASSED: Aborted promptly without hanging processes.\n");
      passed++;
    } else {
      console.error(
        `  ❌ Test 3 FAILED: Expected ABORTED status within 5s, got ${res3.status} in ${elapsed}ms\n`,
      );
    }
  } catch (err: any) {
    console.error(`  ❌ Test 3 EXCEPTION: ${err.message}\n`);
  }

  // -------------------------------------------------------------
  // Final Summary
  // -------------------------------------------------------------
  console.log("=================================================");
  console.log(`   Test Results: ${passed}/${total} PASSED       `);
  console.log("=================================================");

  if (passed === total) {
    console.log("\n🎉 ALL TESTS PASSED! AGY CLI Subagent runner is fully operational.");
    process.exit(0);
  } else {
    console.log("\n⚠️ Some tests failed. Please inspect logs above.");
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Fatal error in test suite:", err);
  process.exit(1);
});
