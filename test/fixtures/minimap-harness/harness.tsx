/**
 * MessageList minimap verification harness.
 *
 * Mounts the real MessageList inside a ChatPage-like flex column.
 *
 * Two deterministic fixtures are available through the URL:
 *   (default)         12 messages (7 user / 5 assistant, varying lengths, with a
 *                     pair of consecutive user questions so two highlights can
 *                     be observed at once).
 *   ?mode=bulk        80 user questions each followed by a short answer, so the
 *                     number of lines exceeds the container capacity and the
 *                     adaptive slot compression path is exercised.
 *
 * window.__minimap API:
 *   count              number of messages
 *   userCount          number of user messages (== expected line count)
 *   users              [{ index, text }] for every user message, in line order
 *   weights            per-user-message character weight (same shape as source)
 *   roles              per-message role
 *   appendStream(chars) grow the streaming tail (ResizeObserver rebuild check)
 *   reset()            clear the streaming tail
 *   metrics()          { scrollTop, scrollHeight, clientHeight }
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { UIMessage } from "../../../shared/protocol";
import { MessageList } from "../../../src/components/MessageList";
import "./harness.css";

const DEFAULT_RAW: { role: "user" | "assistant"; text: string }[] = [
  { role: "user", text: "MSG-00 hello there" },
  { role: "assistant", text: "MSG-01 " + "long assistant paragraph ".repeat(45) },
  { role: "user", text: "MSG-02 follow up question" },
  { role: "user", text: "MSG-03 a second question right after" },
  { role: "assistant", text: "MSG-04 " + "medium assistant answer ".repeat(12) },
  { role: "user", text: "MSG-05 more" },
  { role: "assistant", text: "MSG-06 " + "another answer ".repeat(20) },
  { role: "user", text: "MSG-07 ping" },
  { role: "assistant", text: "MSG-08 " + "reply body ".repeat(30) },
  { role: "user", text: "MSG-09 last question" },
  { role: "assistant", text: "MSG-10 " + "final long body ".repeat(40) },
  { role: "user", text: "MSG-11 tail" },
];

const BULK_USER_COUNT = 80;

function toMessages(raw: { role: "user" | "assistant"; text: string }[]): UIMessage[] {
  return raw.map((r) => ({ role: r.role, content: [{ type: "text", text: r.text }] }));
}

function buildBulk(): UIMessage[] {
  const raw: { role: "user" | "assistant"; text: string }[] = [];
  for (let i = 0; i < BULK_USER_COUNT; i++) {
    raw.push({ role: "user", text: `BULK-${i} question ${"x".repeat(i % 9)}` });
    raw.push({ role: "assistant", text: `short answer ${i}` });
  }
  return toMessages(raw);
}

const MODE =
  new URLSearchParams(window.location.search).get("mode") === "bulk" ? "bulk" : "default";

function textOf(m: UIMessage): string {
  return m.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .trim();
}

function makeChunk(chars: number): string {
  const unit = "stream content 流式内容 — appended after the last message. ";
  let out = "";
  while (out.length < chars) out += unit;
  return out.slice(0, chars);
}

function App() {
  const [streamText, setStreamText] = useState("");
  const chunkRef = useRef(320);
  const [messages] = useState<UIMessage[]>(() =>
    MODE === "bulk" ? buildBulk() : toMessages(DEFAULT_RAW),
  );

  useEffect(() => {
    const users = messages
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => m.role === "user")
      .map(({ m, index }) => ({ index, text: textOf(m) }));
    const api = {
      count: messages.length,
      userCount: users.length,
      users,
      weights: users.map((u) => Math.max(u.text.length, 1)),
      roles: messages.map((m) => m.role),
      appendStream(chars = chunkRef.current) {
        setStreamText((prev) => prev + makeChunk(chars));
      },
      reset() {
        setStreamText("");
      },
      metrics() {
        const el = document.querySelector<HTMLElement>(".thin-scroll");
        if (!el) return null;
        return {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        };
      },
    };
    (window as unknown as { __minimap: typeof api }).__minimap = api;
  }, [messages]);

  return (
    <div className="flex h-full min-h-0 w-full flex-1 bg-sidebar">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
        <header className="flex shrink-0 items-center border-b-2 border-line bg-sidebar/80 px-3 py-2.5 font-mono text-xs">
          minimap harness (header)
        </header>
        <MessageList
          messages={messages}
          streamText={streamText}
          streamThinking=""
          activeTools={[]}
          isStreaming={false}
        />
        <div className="composer-bar shrink-0 border-t-2 border-line bg-sidebar px-3 py-2.5 font-mono text-xs">
          composer placeholder
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
