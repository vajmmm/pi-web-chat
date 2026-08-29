import { Dialog } from "@base-ui-components/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { UIProjectFolder, UIProjectItem, UISessionInfo } from "../../shared/protocol";
import {
  deleteFolderApi,
  deleteProjectApi,
  deleteSessionApi,
  useInvalidateProjects,
  useInvalidateSessions,
  useProjects,
  useSessions,
} from "../lib/api";
import { chatClient, useChat } from "../lib/chat";
import { onRequestOpenSessionsDrawer } from "../lib/drawer";
import { useT } from "../lib/i18n";
import { setSidebarPinned, useSidebarPinned } from "../lib/sidebar";
import { CwdSelector } from "./CwdSelector";

const EXPANDED_PROJECTS_KEY = "pi_expanded_projects";

function getStoredExpandedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_PROJECTS_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveStoredExpandedProjects(keys: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(Array.from(keys)));
  } catch {
    /* ignore */
  }
}

function SidebarPanelIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px] fill-none stroke-current stroke-[1.8]">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.5 4v16" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-[2.2]">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-[1.8]">
      <path d="M3 4h18l-7 8v6l-4 2v-8L3 4z" strokeLinejoin="round" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-[1.8]">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-[1.8]">
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function SessionItemRow({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: UISessionInfo;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const title = session.name ?? session.firstMessage ?? "新会话";
  return (
    <div
      className={`group relative flex w-full items-center justify-between gap-1.5 border px-2 py-1.5 font-mono transition-colors rounded ${
        active
          ? "border-accent bg-canvas font-bold text-ink shadow-[1px_1px_0_var(--color-line)]"
          : "border-transparent text-muted hover:border-line-bright/60 hover:bg-hover hover:text-ink"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        title={`${title}\n${session.modified}`}
        className="min-w-0 flex-1 text-left"
      >
        <div className="truncate text-xs">{title}</div>
      </button>

      <div className="flex items-center gap-1 shrink-0">
        {session.relativeTime && (
          <span className="text-[10px] text-faint group-hover:hidden">
            {session.relativeTime}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="删除此会话记录"
          className="hidden size-5 items-center justify-center rounded text-faint hover:bg-red-500/10 hover:text-red-500 group-hover:flex"
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

function ProjectAccordionItem({
  project,
  expanded,
  onToggle,
  currentSessionFile,
  currentCwd,
  onSelectSession,
  onNewSessionInProject,
  onDeleteSession,
  onDeleteProject,
  onDeleteFolder,
}: {
  project: UIProjectItem;
  expanded: boolean;
  onToggle: () => void;
  currentSessionFile?: string;
  currentCwd?: string;
  onSelectSession: (session: UISessionInfo, projectCwd: string) => void;
  onNewSessionInProject: (projectCwd: string) => void;
  onDeleteSession: (session: UISessionInfo) => void;
  onDeleteProject: (project: UIProjectItem) => void;
  onDeleteFolder: (folderPath: string, folderName: string) => void;
}) {
  const isCurrentProject = currentCwd === project.projectRoot || project.folders.some((f) => f.path === currentCwd);
  const hasMultipleFolders = project.folders.length > 1;

  return (
    <div className="space-y-0.5">
      {/* 项目根头部 */}
      <div
        className={`group flex items-center justify-between px-2 py-1 font-mono text-xs transition-colors rounded ${
          isCurrentProject ? "bg-canvas-subtle/80 text-ink" : "text-muted hover:bg-hover hover:text-ink"
        }`}
      >
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="text-[10px] text-faint transition-transform select-none">
            {expanded ? "▼" : "▶"}
          </span>
          <span className="text-accent text-xs select-none">📁</span>
          <span className="truncate font-semibold text-ink">{project.name}</span>
          {hasMultipleFolders && (
            <span className="rounded bg-canvas px-1 py-0.2 text-[9px] text-faint border border-line">
              {project.folders.length} 目录
            </span>
          )}
          {!hasMultipleFolders && project.gitBranch && (
            <span className="hidden rounded bg-accent/10 px-1 py-0.1 text-[9px] text-accent sm:inline">
              {project.gitBranch}
            </span>
          )}
        </button>

        {/* 快捷操作区 */}
        <div className="flex items-center gap-0.5 opacity-80 group-hover:opacity-100">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNewSessionInProject(project.projectRoot);
            }}
            title={`在 ${project.name} 下新建会话`}
            className="flex size-5 items-center justify-center border border-transparent rounded hover:border-line-bright hover:bg-canvas hover:text-accent text-faint"
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteProject(project);
            }}
            title={`删除项目「${project.name}」及所有会话记录`}
            className="hidden size-5 items-center justify-center border border-transparent rounded hover:border-red-400 hover:bg-red-500/10 hover:text-red-500 text-faint group-hover:flex"
          >
            <TrashIcon />
          </button>
        </div>
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div className="ml-3.5 space-y-1 border-l border-dashed border-line pl-1.5 pt-0.5 pb-1">
          {hasMultipleFolders ? (
            /* 多文件夹 / 多 Worktree 模式 */
            project.folders.map((folder) => {
              const isCurrentFolder = currentCwd === folder.path;
              const displayName = folder.branch || folder.name;
              return (
                <div key={folder.path} className="space-y-0.5">
                  {/* 子文件夹/分支标题 */}
                  <div
                    className={`group/f flex items-center justify-between px-1.5 py-0.5 font-mono text-[11px] rounded transition-colors ${
                      isCurrentFolder ? "bg-canvas text-accent font-bold" : "text-faint hover:text-ink"
                    }`}
                  >
                    <div className="flex items-center gap-1 truncate" title={folder.path}>
                      <span className="text-[10px]">🌿</span>
                      <span className="truncate">{displayName}</span>
                      {folder.isMain && <span className="text-[9px] text-faint opacity-75">(main)</span>}
                    </div>

                    <div className="flex items-center gap-0.5 opacity-0 group-hover/f:opacity-100">
                      <button
                        type="button"
                        onClick={() => onNewSessionInProject(folder.path)}
                        title={`在 ${displayName} 下新建会话`}
                        className="flex size-4 items-center justify-center rounded hover:bg-canvas hover:text-accent text-faint"
                      >
                        <PlusIcon />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteFolder(folder.path, displayName)}
                        title={`清理 ${displayName} 下的会话`}
                        className="flex size-4 items-center justify-center rounded hover:bg-red-500/10 hover:text-red-500 text-faint"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>

                  {/* 该文件夹下的会话 */}
                  <div className="ml-2 space-y-0.5">
                    {folder.sessions.length > 0 ? (
                      folder.sessions.map((s) => (
                        <SessionItemRow
                          key={s.path}
                          session={s}
                          active={s.path === currentSessionFile}
                          onSelect={() => onSelectSession(s, folder.path)}
                          onDelete={() => onDeleteSession(s)}
                        />
                      ))
                    ) : (
                      <div className="px-2 py-0.5 text-[10px] italic text-faint">
                        No conversations
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            /* 单文件夹模式 */
            project.sessions.length > 0 ? (
              project.sessions.map((s) => (
                <SessionItemRow
                  key={s.path}
                  session={s}
                  active={s.path === currentSessionFile}
                  onSelect={() => onSelectSession(s, project.projectRoot)}
                  onDelete={() => onDeleteSession(s)}
                />
              ))
            ) : (
              <div className="px-2 py-1 text-[11px] italic text-faint">
                No conversations yet
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function useSessionListSync(enabled: boolean) {
  const invalidate = useInvalidateSessions();
  const { snapshot } = useChat();
  const sessionFile = snapshot?.sessionFile;
  const isStreaming = snapshot?.isStreaming ?? false;
  const prevStreaming = useRef(isStreaming);

  useEffect(() => {
    if (!enabled || !sessionFile) return;
    void invalidate();
  }, [enabled, sessionFile, invalidate]);

  useEffect(() => {
    if (!enabled) {
      prevStreaming.current = isStreaming;
      return;
    }
    if (prevStreaming.current && !isStreaming) {
      void invalidate();
    }
    prevStreaming.current = isStreaming;
  }, [enabled, isStreaming, invalidate]);
}

function SessionsPanel({
  currentSessionFile,
  docked,
  active = true,
  onSelectSession,
  onClose,
  onDock,
}: {
  currentSessionFile?: string;
  docked?: boolean;
  active?: boolean;
  onSelectSession?: () => void;
  onClose?: () => void;
  onDock?: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const sidebarPinned = useSidebarPinned();
  const { snapshot } = useChat();
  const currentCwd = snapshot?.cwd;

  const { data: projects = [], refetch: refetchProjects } = useProjects(active);
  const { data: recentSessions = [], refetch: refetchSessions } = useSessions(active, currentCwd);
  useSessionListSync(active);

  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => getStoredExpandedProjects());
  const [cwdSelectorOpen, setCwdSelectorOpen] = useState(false);

  // 默认展开当前项目及前两个项目
  useEffect(() => {
    if (projects.length > 0) {
      setExpandedProjects((prev) => {
        const next = new Set(prev);
        if (currentCwd) next.add(currentCwd);
        // 如果之前为空，展开前 3 个项目
        if (prev.size === 0) {
          projects.slice(0, 3).forEach((p) => next.add(p.cwd));
        }
        return next;
      });
    }
  }, [projects, currentCwd]);

  const toggleProject = (cwd: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      saveStoredExpandedProjects(next);
      return next;
    });
  };

  const handleSelectSession = (s: UISessionInfo, projectCwd: string) => {
    void navigate({ to: "/s/$sessionId", params: { sessionId: s.id } });
    chatClient.connect(s.id, { force: true, cwd: projectCwd || s.cwd });
    onSelectSession?.();
  };

  const handleNewSessionInProject = (projectCwd: string) => {
    void navigate({ to: "/" });
    chatClient.connect(null, { force: true, cwd: projectCwd });
    window.setTimeout(() => {
      void refetchProjects();
      void refetchSessions();
    }, 150);
    onClose?.();
    chatClient.requestComposerFocus();
  };

  const toggleDock = () => {
    if (sidebarPinned) {
      setSidebarPinned(false);
      return;
    }
    if (onDock) onDock();
    else setSidebarPinned(true);
  };

  const handleDeleteSession = async (s: UISessionInfo) => {
    const title = s.name || s.firstMessage || s.id;
    if (!window.confirm(`确定删除会话「${title.slice(0, 30)}」吗？`)) return;
    try {
      await deleteSessionApi(s.id, s.cwd);
      void refetchProjects();
      void refetchSessions();
      if (s.path === currentSessionFile) {
        void navigate({ to: "/" });
        chatClient.connect(null, { force: true });
      }
    } catch (err) {
      alert(`删除会话失败: ${String(err)}`);
    }
  };

  const handleDeleteProject = async (p: UIProjectItem) => {
    const sessionCount = p.sessions.length;
    const msg = `确定要从列表中移除项目「${p.name}」并删除其下属的所有 ${sessionCount} 条会话记录吗？\n\n（注意：仅清理会话历史，不会删除您的实际源码）`;
    if (!window.confirm(msg)) return;
    try {
      await deleteProjectApi(p.cwd);
      const isCurrent =
        p.cwd === currentCwd ||
        p.projectRoot === currentCwd ||
        p.folders.some((f) => f.path === currentCwd);
      if (isCurrent) {
        const remaining = projects.filter((item) => item.projectRoot !== p.projectRoot);
        const nextCwd = remaining[0]?.cwd || "";
        void navigate({ to: "/" });
        chatClient.connect(null, { force: true, cwd: nextCwd });
      }
      void refetchProjects();
      void refetchSessions();
    } catch (err) {
      alert(`删除项目失败: ${String(err)}`);
    }
  };

  const handleDeleteFolder = async (folderPath: string, folderName: string) => {
    if (!window.confirm(`确定要清理工作区「${folderName}」下的所有会话记录吗？\n\n（注意：仅清理会话历史，不会影响您的实际源码）`)) return;
    try {
      await deleteFolderApi(folderPath);
      if (currentCwd === folderPath) {
        const remaining = projects.filter((item) => item.cwd !== folderPath);
        const nextCwd = remaining[0]?.cwd || "";
        void navigate({ to: "/" });
        chatClient.connect(null, { force: true, cwd: nextCwd });
      }
      void refetchProjects();
      void refetchSessions();
    } catch (err) {
      alert(`清理工作区失败: ${String(err)}`);
    }
  };

  const filteredProjects = projects.filter((p) => {
    if (!filterQuery.trim()) return true;
    const q = filterQuery.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.displayPath.toLowerCase().includes(q) ||
      p.folders.some((f) => f.name.toLowerCase().includes(q) || (f.branch && f.branch.toLowerCase().includes(q))) ||
      p.sessions.some((s) => (s.name || s.firstMessage).toLowerCase().includes(q))
    );
  });

  return (
    <>
      {/* 顶部标题栏 */}
      <div
        className={`flex items-center justify-between gap-2 border-b-2 border-line px-3 py-2.5 ${
          docked ? "pt-2.5" : "pt-[calc(0.75rem+env(safe-area-inset-top))]"
        }`}
      >
        <div className="flex items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center border-2 border-accent bg-purple-dark text-sm font-black text-accent shadow-[var(--pixel-shadow-sm)]">
            π
          </div>
          {docked ? (
            <h2 className="font-mono text-sm font-black tracking-widest text-ink">
              PI // CHAT
            </h2>
          ) : (
            <Dialog.Title className="font-mono text-sm font-black tracking-widest text-ink">
              PI // CHAT
            </Dialog.Title>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={toggleDock}
            title={sidebarPinned ? t("closeSidebar") : t("pinSidebar")}
            aria-label={sidebarPinned ? t("closeSidebar") : t("pinSidebar")}
            aria-pressed={sidebarPinned}
            className="hidden size-8 items-center justify-center border-2 border-transparent text-faint transition-all hover:border-line-bright hover:bg-hover hover:text-ink md:flex"
          >
            <SidebarPanelIcon />
          </button>
        </div>
      </div>

      {/* Projects 标题栏与操作按钮 */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5 font-mono text-xs text-faint">
        <span className="font-bold tracking-wider text-ink uppercase">Projects</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFilterOpen(!filterOpen)}
            title="搜索/过滤项目与对话"
            className={`flex size-6 items-center justify-center rounded border transition-colors ${
              filterOpen ? "border-accent bg-canvas text-accent" : "border-transparent hover:bg-hover hover:text-ink"
            }`}
          >
            <FilterIcon />
          </button>
          <button
            type="button"
            onClick={() => setCwdSelectorOpen(true)}
            title="添加/打开新项目目录"
            className="flex size-6 items-center justify-center rounded border border-transparent transition-colors hover:bg-hover hover:text-accent"
          >
            <FolderPlusIcon />
          </button>
        </div>
      </div>

      {/* 搜索框 */}
      {filterOpen && (
        <div className="px-3 pb-2">
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="搜索项目或对话..."
            className="w-full border-2 border-line bg-canvas px-2 py-1 font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-accent"
            autoFocus
          />
        </div>
      )}

      {/* 项目与会话树形列表 */}
      <div className="thin-scroll flex-1 space-y-1.5 overflow-y-auto px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {filteredProjects.length > 0 ? (
          filteredProjects.map((project) => (
            <ProjectAccordionItem
              key={project.id}
              project={project}
              expanded={expandedProjects.has(project.id)}
              onToggle={() => toggleProject(project.id)}
              currentSessionFile={currentSessionFile}
              currentCwd={currentCwd}
              onSelectSession={handleSelectSession}
              onNewSessionInProject={handleNewSessionInProject}
              onDeleteSession={handleDeleteSession}
              onDeleteProject={handleDeleteProject}
              onDeleteFolder={handleDeleteFolder}
            />
          ))
        ) : (
          <div className="px-4 py-6 text-center font-mono text-xs text-faint">
            {filterQuery ? "未找到匹配的项目" : "暂无项目目录"}
          </div>
        )}

        {/* 底部独立会话区域 (Conversations) */}
        <div className="mt-4 border-t border-line/80 pt-3">
          <div className="flex items-center justify-between px-1.5 pb-1 font-mono text-xs text-faint">
            <span className="font-bold tracking-wider text-ink uppercase">Conversations</span>
            <button
              type="button"
              onClick={() => handleNewSessionInProject(currentCwd || "")}
              title="新建独立对话"
              className="flex size-5 items-center justify-center rounded hover:bg-hover hover:text-accent"
            >
              <PlusIcon />
            </button>
          </div>

          <div className="space-y-0.5">
            {recentSessions.slice(0, 8).map((s) => {
              const active = s.path === currentSessionFile;
              return (
                <div
                  key={s.path}
                  className={`group flex w-full items-center justify-between px-2 py-1.5 font-mono text-xs transition-colors rounded ${
                    active ? "bg-canvas font-bold text-ink border border-line shadow-[1px_1px_0_var(--color-line)]" : "text-muted hover:bg-hover hover:text-ink"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleSelectSession(s, currentCwd || "")}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="truncate block">{s.name || s.firstMessage || "对话"}</span>
                  </button>
                  <div className="flex items-center gap-1 shrink-0 ml-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteSession(s);
                      }}
                      title="删除此会话记录"
                      className="hidden size-4 items-center justify-center rounded text-faint hover:bg-red-500/10 hover:text-red-500 group-hover:flex"
                    >
                      <TrashIcon />
                    </button>
                    <span
                      className={`size-1.5 rounded-full shrink-0 ${
                        active ? "bg-accent" : "bg-faint/40"
                      }`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 目录切换弹窗 */}
      <CwdSelector
        open={cwdSelectorOpen}
        onOpenChange={setCwdSelectorOpen}
        hideTrigger={true}
        cwd={currentCwd}
        cwdName={snapshot?.cwdName}
        isGitRepo={snapshot?.isGitRepo}
        gitBranch={snapshot?.gitBranch}
        onSelectCwd={(newCwd) => {
          void navigate({ to: "/" });
          chatClient.connect(null, { force: true, cwd: newCwd });
          void refetchProjects();
          void refetchSessions();
        }}
      />
    </>
  );
}

export function SessionsSidebar({ currentSessionFile }: { currentSessionFile?: string }) {
  return (
    <aside className="hidden h-full min-h-0 w-64 shrink-0 flex-col overflow-hidden bg-sidebar md:flex border-r-2 border-line">
      <SessionsPanel currentSessionFile={currentSessionFile} docked active />
    </aside>
  );
}

export function SessionsDrawer({ currentSessionFile }: { currentSessionFile?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [instantHide, setInstantHide] = useState(false);
  const sidebarPinned = useSidebarPinned();

  const dockFromDrawer = () => {
    setInstantHide(true);
    setSidebarPinned(true);
    setOpen(false);
  };

  useEffect(() => {
    return onRequestOpenSessionsDrawer(() => {
      if (sidebarPinned) return;
      setInstantHide(false);
      setOpen(true);
    });
  }, [sidebarPinned]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setInstantHide(false);
        setOpen(next);
      }}
    >
      <Dialog.Trigger
        className={`flex size-9 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink ${
          sidebarPinned ? "md:hidden" : ""
        }`}
        aria-label={t("sessionList")}
      >
        <SidebarPanelIcon />
      </Dialog.Trigger>
      {!instantHide && (
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
          <Dialog.Popup className="fixed inset-y-0 left-0 flex w-[82vw] max-w-xs flex-col bg-sidebar shadow-2xl outline-none transition-transform data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full">
            <SessionsPanel
              currentSessionFile={currentSessionFile}
              active={open}
              onSelectSession={() => setOpen(false)}
              onClose={() => setOpen(false)}
              onDock={dockFromDrawer}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}

