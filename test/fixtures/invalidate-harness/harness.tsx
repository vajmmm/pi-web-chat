/**
 * Session sidebar invalidate-loop reproduction harness.
 *
 * Mounts the real `useProjects` / `useSessions` query hooks together with the
 * real `useSessionListSync` effect (from SessionsDrawer) inside a
 * QueryClientProvider, against a deterministic in-memory `/api/*` mock.
 *
 * If `useInvalidateSessions` returns a fresh function on every render, the
 * sync effect re-runs on every render -> invalidate -> refetch -> re-render ->
 * invalidate, so the request counters keep climbing while the page is idle.
 *
 * window.__harness API:
 *   reset()            zero the counters
 *   stats()            { sessions, projects, renders }
 *   ping(n)            force n parent re-renders (simulates external re-render)
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { useProjects, useSessions } from "../../../src/lib/api";
import { useSessionListSync } from "../../../src/components/SessionsDrawer";
import { chatClient } from "../../../src/lib/chat";

const counts = { sessions: 0, projects: 0 };
let renders = 0;
let nonce = 0;

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("/api/sessions/running")) {
    return Promise.resolve(jsonResponse({ sessionIds: [] }));
  }
  if (url.startsWith("/api/sessions")) {
    counts.sessions++;
    nonce++;
    // Vary the payload so structural sharing can never mask the refetch.
    return Promise.resolve(jsonResponse([{ id: `s${nonce}`, cwd: "/tmp", modified: "" }]));
  }
  if (url.startsWith("/api/projects")) {
    counts.projects++;
    nonce++;
    return Promise.resolve(
      jsonResponse([
        {
          id: `p${nonce}`,
          name: `p${nonce}`,
          cwd: "/tmp",
          displayPath: "/tmp",
          projectRoot: "/tmp",
          folders: [],
          sessions: [],
        },
      ]),
    );
  }
  return realFetch(input, init);
}) as typeof window.fetch;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
});

function Probe() {
  renders++;
  useProjects(true);
  useSessions(true);
  // Real effect from SessionsDrawer; the loop lives here.
  useSessionListSync(true);
  return <div id="probe">probe</div>;
}

function Root() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  return (
    <QueryClientProvider client={queryClient}>
      <button id="ping" onClick={force}>
        ping
      </button>
      <Probe />
    </QueryClientProvider>
  );
}

declare global {
  interface Window {
    __harness: {
      reset: () => void;
      stats: () => { sessions: number; projects: number; renders: number };
      ping: () => void;
      emitTitleChange: () => void;
    };
  }
}

window.__harness = {
  reset() {
    counts.sessions = 0;
    counts.projects = 0;
    renders = 0;
  },
  stats() {
    return { sessions: counts.sessions, projects: counts.projects, renders };
  },
  ping() {
    document.getElementById("ping")?.click();
  },
  emitTitleChange() {
    // Drive the real client's session_name_changed path: the sync effect must
    // still refresh sessions + projects when a title arrives.
    (chatClient as unknown as { handle: (e: unknown) => void }).handle({
      type: "session_name_changed",
    });
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
