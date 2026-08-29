import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useState } from "react";
import type { UICwdValidateResponse } from "../../shared/protocol";
import { getHomeDir, pickDirectoryApi, validateCwd } from "../lib/api";
import { FolderBrowserModal } from "./FolderBrowserModal";

const RECENT_CWDS_KEY = "pi_recent_cwds";

function getRecentCwds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_CWDS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function addRecentCwd(path: string) {
  try {
    const list = getRecentCwds().filter((p) => p !== path);
    list.unshift(path);
    localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    /* ignore */
  }
}

interface CwdSelectorProps {
  cwd?: string;
  cwdName?: string;
  isGitRepo?: boolean;
  gitBranch?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  onSelectCwd: (cwd: string) => void;
}

export function CwdSelector({
  cwd,
  cwdName,
  isGitRepo,
  gitBranch,
  open: controlledOpen,
  onOpenChange: setControlledOpen,
  hideTrigger = false,
  onSelectCwd,
}: CwdSelectorProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    setControlledOpen?.(next);
    setInternalOpen(next);
  };

  const [inputPath, setInputPath] = useState("");
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<UICwdValidateResponse | null>(null);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [homeDir, setHomeDir] = useState<string>("");
  const [isPicking, setIsPicking] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setInputPath(cwd || "");
      setRecentCwds(getRecentCwds());
      getHomeDir()
        .then((res) => setHomeDir(res.home))
        .catch(() => {});
      if (cwd) {
        checkPath(cwd);
      }
    }
  }, [open, cwd]);

  const checkPath = async (p: string) => {
    if (!p.trim()) {
      setValidation(null);
      return;
    }
    setValidating(true);
    try {
      const res = await validateCwd(p.trim());
      setValidation(res);
    } catch {
      setValidation({
        ok: false,
        path: p,
        displayPath: p,
        name: "",
        isGitRepo: false,
        error: "校验失败",
      });
    } finally {
      setValidating(false);
    }
  };

  const handlePickDirectory = async () => {
    setIsPicking(true);
    try {
      const res = await pickDirectoryApi(inputPath || cwd || homeDir);
      if (res.ok && res.path) {
        setInputPath(res.path);
        checkPath(res.path);
      } else if (res.fallback) {
        setBrowserOpen(true);
      }
    } catch {
      setBrowserOpen(true);
    } finally {
      setIsPicking(false);
    }
  };

  const handleApply = (targetPath: string) => {
    const trimmed = targetPath.trim();
    if (!trimmed) return;
    addRecentCwd(validation?.path || trimmed);
    onSelectCwd(validation?.path || trimmed);
    setOpen(false);
  };

  return (
    <>
      {!hideTrigger && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 border-2 border-line bg-canvas px-2 py-1 font-mono text-xs font-semibold text-ink shadow-[2px_2px_0_var(--color-line)] transition hover:bg-canvas-subtle hover:border-accent active:translate-x-0.5 active:translate-y-0.5 active:shadow-none"
          title={`当前工作目录: ${cwd || "未指定"}`}
        >
          <span className="text-accent">📁</span>
          <span className="max-w-[130px] truncate">{cwdName || (cwd ? cwd.split("/").pop() : "工作目录")}</span>
          {gitBranch && (
            <span className="rounded bg-accent/10 px-1 py-0.2 font-mono text-[10px] text-accent">
              🌿 {gitBranch}
            </span>
          )}
        </button>
      )}

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs animate-in fade-in-0 duration-100" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col border-2 border-line bg-canvas shadow-[4px_4px_0_var(--color-line)] outline-none animate-in fade-in-0 zoom-in-95 duration-100">
            <div className="flex items-center justify-between border-b-2 border-line bg-canvas-subtle px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-base text-accent">📁</span>
                <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
                  切换工作目录 (Workspace Directory)
                </h2>
              </div>
              <Dialog.Close className="border-2 border-line bg-canvas px-1.5 py-0.5 font-mono text-xs font-bold hover:bg-canvas-subtle hover:text-accent">
                ✕
              </Dialog.Close>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-4 font-mono text-xs">
              {/* 当前活动目录 */}
              <div className="border-2 border-line bg-canvas-subtle p-2.5">
                <div className="text-[11px] font-bold text-faint">当前会话工作目录</div>
                <div className="mt-1 break-all font-semibold text-ink">{cwd || "默认目录 (~/.pi/web-chat)"}</div>
                {gitBranch && (
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-accent">
                    <span>🌿 Git 分支:</span>
                    <span className="font-bold">{gitBranch}</span>
                  </div>
                )}
              </div>

              {/* 输入目标目录 */}
              <div className="space-y-1.5">
                <label className="block font-bold text-ink">输入新项目/工作区路径 (支持绝对路径或 ~)</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={inputPath}
                    onChange={(e) => {
                      setInputPath(e.target.value);
                      checkPath(e.target.value);
                    }}
                    placeholder="/Users/username/project 或 ~/workspace"
                    className="flex-1 border-2 border-line bg-canvas px-2.5 py-1.5 font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-accent"
                  />
                  <button
                    type="button"
                    disabled={isPicking}
                    onClick={handlePickDirectory}
                    className="border-2 border-line bg-canvas px-2.5 py-1.5 font-mono text-xs font-bold hover:bg-canvas-subtle hover:border-accent active:translate-x-0.5 active:translate-y-0.5 flex items-center gap-1 shrink-0 disabled:opacity-50"
                    title="唤起系统选择器选择本地文件夹"
                  >
                    <span>📁</span>
                    <span>{isPicking ? "选择中..." : "选择文件夹"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setBrowserOpen(true)}
                    className="border-2 border-line bg-canvas px-2 py-1.5 font-mono text-xs hover:bg-canvas-subtle hover:border-accent active:translate-x-0.5 active:translate-y-0.5 flex items-center gap-1 shrink-0"
                    title="在网页内浏览目录树"
                  >
                    <span>📂</span>
                    <span>浏览</span>
                  </button>
                </div>

                {/* 实时校验反馈 */}
                {validating && <div className="text-[11px] text-faint">正在校验路径...</div>}
                {!validating && validation && (
                  <div
                    className={`mt-1 rounded border p-2 text-[11px] ${
                      validation.ok
                        ? "border-emerald-600/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "border-red-600/30 bg-red-500/10 text-red-600 dark:text-red-400"
                    }`}
                  >
                    {validation.ok ? (
                      <div className="flex flex-col gap-0.5">
                        <div className="font-bold">✅ 目录有效: {validation.displayPath}</div>
                        {validation.isGitRepo && (
                          <div className="text-[10px] text-accent">
                            🌿 识别到 Git 仓库 (当前分支: {validation.gitBranch || "HEAD"})
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="font-bold">❌ {validation.error || "路径无效或不是文件夹"}</div>
                    )}
                  </div>
                )}
              </div>

              {/* 最近使用的项目目录 */}
              {recentCwds.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-faint">最近访问的项目</span>
                    <button
                      type="button"
                      onClick={() => {
                        localStorage.removeItem(RECENT_CWDS_KEY);
                        setRecentCwds([]);
                      }}
                      className="text-[10px] text-faint hover:text-red-500"
                    >
                      清空历史
                    </button>
                  </div>
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {recentCwds.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => {
                          setInputPath(p);
                          checkPath(p);
                        }}
                        className="flex w-full items-center justify-between border border-line/60 bg-canvas px-2 py-1 text-left text-[11px] transition hover:border-accent hover:bg-canvas-subtle"
                      >
                        <span className="truncate">{p}</span>
                        <span className="text-[10px] text-faint">选择</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t-2 border-line bg-canvas-subtle px-4 py-2.5">
              <span className="text-[11px] text-faint">切换后会话将立即加载该项目环境</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="border-2 border-line bg-canvas px-3 py-1 font-mono text-xs font-bold hover:bg-canvas-subtle"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={!validation?.ok || validating}
                  onClick={() => handleApply(inputPath)}
                  className="border-2 border-line bg-accent px-4 py-1 font-mono text-xs font-bold text-white shadow-[2px_2px_0_var(--color-line)] transition hover:opacity-90 disabled:opacity-50 active:translate-x-0.5 active:translate-y-0.5 active:shadow-none"
                >
                  确认切换
                </button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <FolderBrowserModal
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        initialPath={inputPath || cwd || homeDir}
        onSelect={(selectedPath) => {
          setInputPath(selectedPath);
          checkPath(selectedPath);
        }}
      />
    </>
  );
}
