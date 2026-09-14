import { useNavigate, useParams } from "@tanstack/react-router";
import { Suspense, useEffect, useState } from "react";
import { chatClient, useChat } from "../lib/chat";
import { requestOpenSessionsDrawer } from "../lib/drawer";
import { useT } from "../lib/i18n";
import { useSidebarPinned } from "../lib/sidebar";
import { useLeftEdgeSwipe } from "../lib/useEdgeSwipe";
import { useMountedOnce } from "../lib/useMountedOnce";
import { Composer } from "./Composer";
import { CwdSelector } from "./CwdSelector";
import { LazySubagentDrawer } from "./lazy-modals";
import { MessageList } from "./MessageList";
import { SessionsDrawer, SessionsSidebar } from "./SessionsDrawer";
import { SettingsMenu } from "./SettingsMenu";
import { QueuedMessagesPanel } from "./QueuedMessagesPanel";

function connectionDotClass(connection: "connecting" | "connected" | "disconnected"): string {
  switch (connection) {
    case "connected":
      return "bg-emerald-500/80";
    case "connecting":
      return "bg-amber-400 animate-pulse";
    case "disconnected":
      return "bg-red-500";
  }
}

function connectionLabel(
  connection: "connecting" | "connected" | "disconnected",
  t: ReturnType<typeof useT>,
): string {
  switch (connection) {
    case "connected":
      return t("connected");
    case "connecting":
      return t("connecting");
    case "disconnected":
      return t("disconnected");
  }
}

export function ChatPage() {
  const t = useT();
  const { sessionId: routeSessionId } = useParams({ strict: false });
  const navigate = useNavigate();
  const {
    connection,
    sessionId,
    snapshot,
    streamText,
    streamThinking,
    activeTools,
  } = useChat();

  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const subagentsMounted = useMountedOnce(subagentsOpen);
  const isStreaming = snapshot?.isStreaming ?? false;
  const showConnectingOverlay = connection === "disconnected";
  const sidebarPinned = useSidebarPinned();
  const subagents = snapshot?.subagents ?? [];
  const runningSubagents = subagents.filter((s) => s.status === "running").length;

  useEffect(() => {
    const cwd = chatClient.getCwd() ?? snapshot?.cwd;
    chatClient.connect(routeSessionId ?? null, cwd ? { cwd } : undefined);
  }, [routeSessionId]);

  useEffect(() => {
    if (sessionId && sessionId !== routeSessionId) {
      void navigate({
        to: "/s/$sessionId",
        params: { sessionId },
        replace: routeSessionId === undefined,
      });
    }
  }, [sessionId, routeSessionId, navigate]);

  useLeftEdgeSwipe({
    enabled: !sidebarPinned,
    onSwipeRight: requestOpenSessionsDrawer,
  });

  return (
    <div className="flex h-full min-h-0 w-full flex-1 bg-sidebar">
      {sidebarPinned && <SessionsSidebar currentSessionFile={snapshot?.sessionFile} />}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas md:border-l-2 md:border-line">
        <header className="flex shrink-0 items-center gap-2 border-b-2 border-line bg-sidebar/80 px-3 py-2.5 pt-[max(0.6rem,var(--safe-top))]">
          <SessionsDrawer currentSessionFile={snapshot?.sessionFile} />
          <div className="flex min-w-0 items-center gap-2 px-1">
            {!sidebarPinned && (
              <div className="flex items-center gap-2">
                <div className="flex size-7 shrink-0 items-center justify-center border-2 border-accent bg-purple-dark text-sm font-black text-accent shadow-[var(--pixel-shadow-sm)]">
                  π
                </div>
                <span className="hidden truncate font-mono text-xs font-black tracking-wider text-ink sm:inline">
                  PI // CHAT
                </span>
              </div>
            )}
            <div className="flex items-center gap-1.5 font-mono text-xs text-muted">
              <span
                className={`size-2 shrink-0 rounded-full ${connectionDotClass(connection)}`}
                title={connectionLabel(connection, t)}
                aria-label={connectionLabel(connection, t)}
              />
              <span className="hidden text-[11px] text-faint sm:inline">
                {connectionLabel(connection, t)}
              </span>
            </div>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <CwdSelector
              cwd={snapshot?.cwd}
              cwdName={snapshot?.cwdName}
              isGitRepo={snapshot?.isGitRepo}
              gitBranch={snapshot?.gitBranch}
              onSelectCwd={(newCwd) => {
                chatClient.send({ type: "set_session_cwd", cwd: newCwd });
              }}
            />

            <button
              type="button"
              onClick={() => setSubagentsOpen(true)}
              className="relative flex h-7.5 items-center gap-1 border-2 border-line-bright bg-card px-2.5 font-mono text-xs font-bold text-ink shadow-[var(--pixel-shadow-sm)] hover:translate-x-[1px] hover:translate-y-[1px] hover:border-accent"
              title="查看子任务协同看板"
            >
              <span>⚡ SUBAGENTS</span>
              {runningSubagents > 0 ? (
                <span className="flex size-4 items-center justify-center bg-emerald-500 text-[9px] font-black text-white">
                  {runningSubagents}
                </span>
              ) : subagents.length > 0 ? (
                <span className="flex size-4 items-center justify-center border border-line bg-canvas text-[9px] font-bold text-muted">
                  {subagents.length}
                </span>
              ) : null}
            </button>

            <SettingsMenu />
          </div>
        </header>

        {subagentsMounted && (
          <Suspense fallback={null}>
            <LazySubagentDrawer open={subagentsOpen} onOpenChange={setSubagentsOpen} />
          </Suspense>
        )}

        {showConnectingOverlay ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <span
              className={`size-3 rounded-full ${connectionDotClass(connection)}`}
              aria-hidden
            />
            <p className="font-mono text-xs text-muted">
              {connection === "disconnected" ? t("connectionLost") : t("connectingHint")}
            </p>
          </div>
        ) : (
          <>
            <MessageList
              key={sessionId ?? "new"}
              messages={snapshot?.messages ?? []}
              streamText={streamText}
              streamThinking={streamThinking}
              activeTools={activeTools}
              isStreaming={isStreaming}
            />
            <QueuedMessagesPanel />
            <Composer isStreaming={isStreaming} />
          </>
        )}
      </div>
    </div>
  );
}
