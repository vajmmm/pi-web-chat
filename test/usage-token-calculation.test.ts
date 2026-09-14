import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accumulateUsageFromMessages,
  calculateTokenUsage,
  estimateMessageTokens,
} from "../server/session/usage.ts";

describe("Token Usage & Context Calculation", () => {
  describe("estimateMessageTokens", () => {
    it("estimates text content based on length", () => {
      const msg = { role: "user", content: "Hello world" };
      const est = estimateMessageTokens(msg);
      assert.equal(est, Math.ceil(11 / 3.5));
    });

    it("does not inflate tokens for large base64 image data", () => {
      // 500KB of base64 data
      const base64 = "A".repeat(500_000);
      const msg = {
        role: "user",
        content: [
          { type: "text", text: "Look at this screenshot" },
          { type: "image", data: base64, mimeType: "image/png" },
        ],
      };
      const est = estimateMessageTokens(msg);
      // Expected: text tokens (~7) + fixed image estimate (1200)
      assert.ok(est < 1300, `Expected tokens < 1300 but got ${est}`);
      assert.ok(est >= 1200, `Expected tokens >= 1200 but got ${est}`);
    });

    it("handles compactionSummary and branchSummary correctly", () => {
      const summaryText = "A".repeat(350);
      const msg = { role: "compactionSummary", summary: summaryText };
      assert.equal(estimateMessageTokens(msg), 100);
    });
  });

  describe("accumulateUsageFromMessages", () => {
    it("tracks contextTokens from assistant input + cacheRead", () => {
      const messages = [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          usage: { input: 15000, cacheRead: 5000, output: 200, totalTokens: 20200 },
          stopReason: "stop",
        },
      ];
      const result = accumulateUsageFromMessages(messages);
      assert.equal(result.contextTokens, 20000);
      assert.equal(result.latestTurnTokens, 20200);
    });

    it("does not overwrite contextTokens with 0 on provider error", () => {
      const messages = [
        { role: "user", content: "Task step 1" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Done 1" }],
          usage: { input: 170000, cacheRead: 0, output: 500, totalTokens: 170500 },
          stopReason: "stop",
        },
        { role: "toolResult", content: "output" },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "You have hit your ChatGPT usage limit (plus plan).",
          usage: { input: 0, output: 0, totalTokens: 0 },
        },
      ];
      const result = accumulateUsageFromMessages(messages);
      // Must preserve the last valid context size (170,000), not drop to 0 or inflate to huge estimate
      assert.equal(result.contextTokens, 170000);
    });

    it("prevents stale pre-compaction assistant usage from bleeding into post-compaction context", () => {
      const t0 = 1000;
      const t1 = 2000;
      const t2 = 3000; // compaction timestamp
      const t3 = 4000;

      const messages = [
        {
          role: "compactionSummary",
          summary: "Summary of earlier steps",
          timestamp: t2,
        },
        // Kept pre-compaction assistant message with stale usage (200k)
        {
          role: "assistant",
          timestamp: t1,
          content: [{ type: "text", text: "Kept turn" }],
          usage: { input: 200000, cacheRead: 0, output: 100, totalTokens: 200100 },
          stopReason: "stop",
        },
      ];

      // Right after compaction, before a new assistant turn:
      // Must NOT use stale 200k from kept assistant message!
      const afterCompactionBeforeTurn = accumulateUsageFromMessages(messages);
      assert.ok(
        afterCompactionBeforeTurn.contextTokens < 10000,
        `Expected contextTokens < 10000 after compaction, got ${afterCompactionBeforeTurn.contextTokens}`,
      );

      // Now a post-compaction assistant message arrives with new live usage
      messages.push({
        role: "assistant",
        timestamp: t3,
        content: [{ type: "text", text: "Post compaction turn" }],
        usage: { input: 35000, cacheRead: 1000, output: 500, totalTokens: 36500 },
        stopReason: "stop",
      });

      const afterNewTurn = accumulateUsageFromMessages(messages);
      assert.equal(afterNewTurn.contextTokens, 36000);
      assert.equal(afterNewTurn.latestTurnTokens, 36500);
    });
  });

  describe("calculateTokenUsage", () => {
    it("computes contextPercent and runTokens correctly", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          usage: { input: 136000, cacheRead: 0, output: 500, totalTokens: 136500 },
          stopReason: "stop",
        },
      ];
      const model = { id: "gpt-5.6-sol", contextWindow: 272000 };
      const stats = calculateTokenUsage(messages, model);

      assert.equal(stats.contextTokens, 136000);
      assert.equal(stats.contextWindow, 272000);
      assert.equal(stats.contextPercent, 50); // 136000 / 272000 = 50%
      assert.equal(stats.runTokens, 136500);
    });
  });
});
