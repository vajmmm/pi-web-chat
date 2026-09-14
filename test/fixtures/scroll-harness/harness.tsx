/**
 * MessageList scroll reproduction harness.
 *
 * Mounts the real MessageList inside a ChatPage-like flex column so the
 * "stick to bottom while streaming" behaviour can be driven from Playwright.
 *
 * window.__harness API (all deterministic, no wall-clock dependency for the
 * test itself):
 *   setIntervalMs(ms)  stream cadence
 *   setChunk(chars)    characters appended per stream tick
 *   start()/stop()     start/stop the simulated stream
 *   appendChunk()      append one chunk synchronously
 *   reset()            clear stream text and re-pin to bottom
 *   metrics()          { scrollTop, scrollHeight, clientHeight, distanceFromBottom }
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../../../src/components/MessageList";
import "./harness.css";

const CHUNK =
  "流式输出内容 stream content — lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt. ";

function makeChunk(chars: number): string {
  let out = "";
  while (out.length < chars) out += CHUNK;
  return out.slice(0, chars);
}

function App() {
  const [streamText, setStreamText] = useState("");
  const [isStreaming, setIsStreaming] = useState(true);
  const [runId, setRunId] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunkRef = useRef(320);
  const intervalMsRef = useRef(40);

  const start = () => {
    if (intervalRef.current) return;
    setIsStreaming(true);
    intervalRef.current = setInterval(() => {
      setStreamText((prev) => prev + makeChunk(chunkRef.current));
    }, intervalMsRef.current);
  };

  const stop = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    setIsStreaming(false);
  };

  useEffect(() => {
    start();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const api = {
      setIntervalMs(ms: number) {
        intervalMsRef.current = ms;
        if (intervalRef.current) {
          stop();
          start();
        }
      },
      setChunk(chars: number) {
        chunkRef.current = chars;
      },
      start,
      stop,
      appendChunk() {
        setStreamText((prev) => prev + makeChunk(chunkRef.current));
      },
      reset() {
        setStreamText("");
        setRunId((n) => n + 1);
      },
      metrics() {
        const el = document.querySelector<HTMLElement>(".thin-scroll");
        if (!el) return null;
        return {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
        };
      },
    };
    (window as unknown as { __harness: typeof api }).__harness = api;
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-1 bg-sidebar">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
        <header className="flex shrink-0 items-center border-b-2 border-line bg-sidebar/80 px-3 py-2.5 font-mono text-xs">
          scroll harness (header)
        </header>
        <MessageList
          key={runId}
          messages={[
            {
              role: "user",
              content: [{ type: "text", text: "请写一段很长的内容 streaming test" }],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "第一批内容 first batch。" }],
            },
          ]}
          streamText={streamText}
          streamThinking=""
          activeTools={[]}
          isStreaming={isStreaming}
        />
        <div className="composer-bar shrink-0 border-t-2 border-line bg-sidebar px-3 py-2.5 font-mono text-xs">
          composer placeholder
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
