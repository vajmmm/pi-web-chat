import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAutoTitleState,
  extractAssistantText,
  firstUserMessageText,
  maybeAutoTitle,
  sanitizeTitle,
} from "../server/session/auto-title.ts";
import { bindSessionEvents } from "../server/ws/session-binding.ts";
import { SessionRegistry, type SessionEntry } from "../server/session/session-registry.ts";
import { SubagentManager } from "../server/subagent-manager.ts";
import type { ServerEvent } from "../shared/protocol.ts";

function createTitleSession(options: {
  sessionName?: string;
  messages?: unknown[];
  model?: unknown;
} = {}) {
  const assigned: string[] = [];
  const session = {
    sessionName: options.sessionName,
    messages: options.messages ?? [{ role: "user", content: "帮我修复登录页的样式问题" }],
    model: options.model === undefined ? { provider: "mock", id: "mock-model" } : options.model,
    setSessionName(name: string) {
      assigned.push(name);
      session.sessionName = name;
    },
    assigned,
  };
  return session;
}

function okTitle(text: string) {
  return { content: [{ type: "text", text }] };
}

describe("auto-title helpers", () => {
  it("firstUserMessageText returns the first non-empty user text", () => {
    assert.equal(firstUserMessageText([]), undefined);
    assert.equal(
      firstUserMessageText([{ role: "assistant", content: "hi" }]),
      undefined,
    );
    assert.equal(
      firstUserMessageText([
        { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] },
        { role: "user", content: [{ type: "text", text: "第二句才是文本" }] },
      ]),
      "第二句才是文本",
    );
    assert.equal(
      firstUserMessageText([{ role: "user", content: "  hello world  " }]),
      "hello world",
    );
  });

  it("extractAssistantText joins text blocks and ignores others", () => {
    assert.equal(extractAssistantText({ content: "plain" }), "plain");
    assert.equal(
      extractAssistantText({
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "First" },
          { type: "text", text: "Second" },
        ],
      }),
      "First Second",
    );
    assert.equal(extractAssistantText({ content: [] }), "");
    assert.equal(extractAssistantText(undefined), "");
  });

  it("sanitizeTitle trims quotes, markdown and whitespace", () => {
    assert.equal(sanitizeTitle('  "Fix login page"  '), "Fix login page");
    assert.equal(sanitizeTitle("```\nFix login page\n```"), "Fix login page");
    assert.equal(sanitizeTitle("标题：修复登录页"), "修复登录页");
    assert.equal(sanitizeTitle("   "), undefined);
    assert.equal(sanitizeTitle("abcdefghij", 4), "abcd");
  });

  // D3: Codex-compatible title constraints.
  it("sanitizeTitle parses JSON title payloads", () => {
    assert.equal(sanitizeTitle('{"title":"Fix login page"}'), "Fix login page");
    assert.equal(
      sanitizeTitle('```json\n{"title": "修复登录页。"}\n```'),
      "修复登录页",
    );
    assert.equal(sanitizeTitle('{\n  "title": "Refactor auth flow"\n}'), "Refactor auth flow");
  });

  it("sanitizeTitle strips trailing punctuation", () => {
    assert.equal(sanitizeTitle("Fix login page."), "Fix login page");
    assert.equal(sanitizeTitle("Fix login page!!!"), "Fix login page");
    assert.equal(sanitizeTitle("修复登录页。"), "修复登录页");
  });

  it("sanitizeTitle caps at 36 chars by default and truncates Unicode-safely", () => {
    assert.equal(sanitizeTitle("a".repeat(50))?.length, 36);
    assert.equal(sanitizeTitle("😀😀😀😀😀", 3), "😀😀😀");
    assert.equal(Array.from(sanitizeTitle("😀😀😀😀😀", 3) ?? "").length, 3);
  });
});

describe("maybeAutoTitle", () => {
  it("generates a title from the first user message and writes it", async () => {
    const session = createTitleSession();
    let calls = 0;
    let seenModel: unknown;
    const title = await maybeAutoTitle({
      session,
      model: session.model,
      state: createAutoTitleState(),
      deps: {
        completeSimple: async (model) => {
          calls++;
          seenModel = model;
          return okTitle("Fix login styles");
        },
      },
    });

    assert.equal(calls, 1);
    assert.equal(title, "Fix login styles");
    assert.deepEqual(session.assigned, ["Fix login styles"]);
    assert.equal(seenModel, session.model);
  });

  it("does not call the model when a session name already exists", async () => {
    const session = createTitleSession({ sessionName: "Already named" });
    let calls = 0;
    const title = await maybeAutoTitle({
      session,
      model: session.model,
      state: createAutoTitleState(),
      deps: {
        completeSimple: async () => {
          calls++;
          return okTitle("Should never be used");
        },
      },
    });

    assert.equal(calls, 0);
    assert.equal(title, undefined);
    assert.deepEqual(session.assigned, []);
    assert.equal(session.sessionName, "Already named");
  });

  it("does not call the model when there is no non-empty user message", async () => {
    const session = createTitleSession({ messages: [] });
    let calls = 0;
    const title = await maybeAutoTitle({
      session,
      model: session.model,
      state: createAutoTitleState(),
      deps: {
        completeSimple: async () => {
          calls++;
          return okTitle("nope");
        },
      },
    });

    assert.equal(calls, 0);
    assert.equal(title, undefined);
  });

  it("does not call the model when no model is available", async () => {
    const session = createTitleSession();
    let calls = 0;
    const title = await maybeAutoTitle({
      session,
      model: null,
      state: createAutoTitleState(),
      deps: {
        completeSimple: async () => {
          calls++;
          return okTitle("nope");
        },
      },
    });

    assert.equal(calls, 0);
    assert.equal(title, undefined);
  });

  it("does not throw and does not write a name when completeSimple rejects", async () => {
    const session = createTitleSession();
    const errors: unknown[] = [];
    const title = await maybeAutoTitle({
      session,
      model: session.model,
      state: createAutoTitleState(),
      deps: {
        completeSimple: async () => {
          throw new Error("provider down");
        },
        onError: (err) => errors.push(err),
      },
    });

    assert.equal(title, undefined);
    assert.deepEqual(session.assigned, []);
    assert.equal(errors.length, 1);
  });

  it("does not write a name when the model returns an empty title", async () => {
    const session = createTitleSession();
    const title = await maybeAutoTitle({
      session,
      model: session.model,
      state: createAutoTitleState(),
      deps: {
        completeSimple: async () => ({ content: [{ type: "text", text: "   " }] }),
      },
    });

    assert.equal(title, undefined);
    assert.deepEqual(session.assigned, []);
  });

  it("only triggers one in-flight model call for concurrent invocations", async () => {
    const session = createTitleSession();
    const state = createAutoTitleState();
    let calls = 0;
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const deps = {
      completeSimple: async () => {
        calls++;
        await gate;
        return okTitle("Concurrent title");
      },
    };

    const p1 = maybeAutoTitle({ session, model: session.model, state, deps });
    const p2 = maybeAutoTitle({ session, model: session.model, state, deps });
    const p3 = maybeAutoTitle({ session, model: session.model, state, deps });

    release(undefined);
    const results = await Promise.all([p1, p2, p3]);

    assert.equal(calls, 1);
    assert.equal(results[0], "Concurrent title");
    assert.equal(results[1], undefined);
    assert.equal(results[2], undefined);
    assert.deepEqual(session.assigned, ["Concurrent title"]);
  });

  // D1: a name written while the model call is in flight must win.
  it("does not overwrite a session name set while the model call is in flight", async () => {
    const session = createTitleSession();
    const state = createAutoTitleState();
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const pending = maybeAutoTitle({
      session,
      model: session.model,
      state,
      deps: {
        completeSimple: async () => {
          await gate;
          return okTitle("Late auto title");
        },
      },
    });

    // Simulate a user rename (or another writer) landing mid-flight.
    session.setSessionName("User chose this");
    release(undefined);
    const title = await pending;

    assert.equal(title, undefined);
    assert.deepEqual(session.assigned, ["User chose this"]);
    assert.equal(session.sessionName, "User chose this");
  });

  // D2: a failed attempt must not poison the shared state.
  it("allows a retry after completeSimple fails, then stops once it succeeds", async () => {
    const session = createTitleSession();
    const state = createAutoTitleState();
    let calls = 0;
    const deps = {
      completeSimple: async () => {
        calls++;
        if (calls === 1) throw new Error("provider down");
        return okTitle("Retry title");
      },
      onError: () => {},
    };

    const first = await maybeAutoTitle({ session, model: session.model, state, deps });
    assert.equal(first, undefined);
    assert.equal(calls, 1);

    const second = await maybeAutoTitle({ session, model: session.model, state, deps });
    assert.equal(second, "Retry title");
    assert.equal(calls, 2);
    assert.deepEqual(session.assigned, ["Retry title"]);

    const third = await maybeAutoTitle({ session, model: session.model, state, deps });
    assert.equal(third, undefined);
    assert.equal(calls, 2);
  });

  it("does not retry after a successful call that yields no usable title", async () => {
    const session = createTitleSession();
    const state = createAutoTitleState();
    let calls = 0;
    const deps = {
      completeSimple: async () => {
        calls++;
        return { content: [] };
      },
    };

    await maybeAutoTitle({ session, model: session.model, state, deps });
    await maybeAutoTitle({ session, model: session.model, state, deps });

    assert.equal(calls, 1);
  });

  // D3: the prompt must steer the model toward Codex-compatible titles.
  it("asks for an imperative, same-language title without answering", async () => {
    const session = createTitleSession();
    let prompt = "";
    await maybeAutoTitle({
      session,
      model: session.model,
      state: createAutoTitleState(),
      deps: {
        completeSimple: async (_model, context) => {
          prompt = context.systemPrompt;
          return okTitle("Fix login styles");
        },
      },
    });

    const lower = prompt.toLowerCase();
    assert.match(lower, /imperative/);
    assert.match(lower, /language/);
    assert.match(lower, /(do not|never|don't) answer/);
  });
});

function createMockSession() {
  const subscribers: ((event: any) => void)[] = [];
  const session: any = {
    messages: [{ role: "user", content: "为这个会话生成标题" }],
    isStreaming: false,
    sessionFile: "/tmp/fake-session_auto-title-1.jsonl",
    sessionName: undefined,
    model: { provider: "mock", id: "mock-model" },
    subscribe: (fn: (event: any) => void) => {
      subscribers.push(fn);
      return () => {
        const idx = subscribers.indexOf(fn);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    },
    emit: (event: any) => {
      for (const s of [...subscribers]) s(event);
    },
    setSessionName(name: string) {
      session.sessionName = name;
    },
  };
  return session;
}

function createTestEntry(session: any, services?: any): SessionEntry {
  return {
    id: "auto-title-1",
    runtime: { session, services } as any,
    clients: new Set(),
    lastActive: Date.now(),
    published: true,
    activeRole: "coordinator",
    cwd: "/tmp",
    isGitRepo: false,
    queuedMessages: [],
  };
}

describe("bindSessionEvents auto-title integration", () => {
  it("stays backwards compatible when getModelRuntime is omitted", () => {
    const session = createMockSession();
    const entry = createTestEntry(session);
    const subagentManager = new SubagentManager();
    bindSessionEvents(entry, subagentManager);

    assert.doesNotThrow(() => {
      session.emit({ type: "message_end", message: { role: "user", content: "hi" } });
    });
    assert.equal(session.sessionName, undefined);
  });

  it("auto-titles the first user message_end and broadcasts session_name_changed", async () => {
    const session = createMockSession();
    const entry = createTestEntry(session);
    const subagentManager = new SubagentManager();
    const registry = new SessionRegistry();
    registry.set(entry.id, entry);

    const received: ServerEvent[] = [];
    const fakeWs: any = {
      readyState: 1,
      OPEN: 1,
      send: (data: string) => received.push(JSON.parse(data)),
    };
    entry.clients.add(fakeWs);

    let calls = 0;
    const mockRuntime: any = {
      completeSimple: async () => {
        calls++;
        return okTitle("登录页样式修复");
      },
    };

    bindSessionEvents(entry, subagentManager, () => mockRuntime);

    session.emit({ type: "message_end", message: { role: "user", content: "为这个会话生成标题" } });
    // Wait for async auto-title work to flush.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls, 1);
    assert.equal(session.sessionName, "登录页样式修复");
    const nameEvents = received.filter((e) => e.type === "session_name_changed") as any[];
    assert.equal(nameEvents.length, 1);
    assert.equal(nameEvents[0].name, "登录页样式修复");
    assert.equal(nameEvents[0].sessionId, entry.id);
  });

  it("dedupes concurrent message_end auto-title model calls", async () => {
    const session = createMockSession();
    const entry = createTestEntry(session);
    const subagentManager = new SubagentManager();
    const registry = new SessionRegistry();
    registry.set(entry.id, entry);

    let calls = 0;
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const mockRuntime: any = {
      completeSimple: async () => {
        calls++;
        await gate;
        return okTitle("Only once");
      },
    };

    bindSessionEvents(entry, subagentManager, () => mockRuntime);

    session.emit({ type: "message_end", message: { role: "user", content: "hi" } });
    session.emit({ type: "message_end", message: { role: "user", content: "hi" } });
    release(undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls, 1);
    assert.equal(session.sessionName, "Only once");
  });

  it("stays quiet when auto-title fails through the binding", async () => {
    const session = createMockSession();
    const entry = createTestEntry(session);
    const subagentManager = new SubagentManager();
    const registry = new SessionRegistry();
    registry.set(entry.id, entry);

    const received: ServerEvent[] = [];
    const fakeWs: any = {
      readyState: 1,
      OPEN: 1,
      send: (data: string) => received.push(JSON.parse(data)),
    };
    entry.clients.add(fakeWs);

    const mockRuntime: any = {
      completeSimple: async () => {
        throw new Error("provider down");
      },
    };

    bindSessionEvents(entry, subagentManager, () => mockRuntime);

    session.emit({ type: "message_end", message: { role: "user", content: "为这个会话生成标题" } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(session.sessionName, undefined);
    assert.equal(received.filter((e) => e.type === "session_name_changed").length, 0);
  });

  it("prefers the session runtime so custom providers stay resolvable", async () => {
    const session = createMockSession();
    const sessionRuntime: any = {
      completeSimple: async () => okTitle("Session runtime title"),
    };
    const entry = createTestEntry(session, { modelRuntime: sessionRuntime });
    const subagentManager = new SubagentManager();

    let globalCalls = 0;
    const globalRuntime: any = {
      completeSimple: async () => {
        globalCalls++;
        return okTitle("Global runtime title");
      },
    };

    bindSessionEvents(entry, subagentManager, () => globalRuntime);

    session.emit({ type: "message_end", message: { role: "user", content: "标题" } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(globalCalls, 0);
    assert.equal(session.sessionName, "Session runtime title");
  });
});
