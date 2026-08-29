import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useState } from "react";
import type { UIFsItem } from "../../shared/protocol";
import { listDirectoryApi, pickDirectoryApi } from "../lib/api";

interface FolderBrowserModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPath?: string;
  onSelect: (selectedPath: string) => void;
}

export function FolderBrowserModal({
  open,
  onOpenChange,
  initialPath,
  onSelect,
}: FolderBrowserModalProps) {
  const [currentPath, setCurrentPath] = useState<string>("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [homePath, setHomePath] = useState<string>("");
  const [items, setItems] = useState<UIFsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [isPickingNative, setIsPickingNative] = useState(false);

  const loadDirectory = async (targetPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await listDirectoryApi(targetPath);
      if (res.ok) {
        setCurrentPath(res.currentPath);
        setParentPath(res.parentPath);
        setHomePath(res.homePath);
        setItems(res.items);
      } else {
        setError(res.error || "无法读取目录");
        if (res.currentPath) {
          setCurrentPath(res.currentPath);
          setParentPath(res.parentPath);
          setHomePath(res.homePath);
        }
      }
    } catch (err: unknown) {
      setError(`加载失败: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setFilterQuery("");
      loadDirectory(initialPath);
    }
  }, [open, initialPath]);

  const handlePickNative = async () => {
    setIsPickingNative(true);
    try {
      const res = await pickDirectoryApi(currentPath || initialPath);
      if (res.ok && res.path) {
        onSelect(res.path);
        onOpenChange(false);
      }
    } catch {
      /* ignore */
    } finally {
      setIsPickingNative(false);
    }
  };

  const filteredItems = items.filter((item) =>
    item.name.toLowerCase().includes(filterQuery.toLowerCase()),
  );

  // Split path for breadcrumb navigation
  const pathSegments = currentPath ? currentPath.split("/").filter(Boolean) : [];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs animate-in fade-in-0 duration-100" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-60 flex max-h-[85vh] h-[540px] w-[94vw] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col border-2 border-line bg-canvas shadow-[6px_6px_0_var(--color-line)] outline-none animate-in fade-in-0 zoom-in-95 duration-100">
          {/* Header */}
          <div className="flex items-center justify-between border-b-2 border-line bg-canvas-subtle px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-base text-accent">📂</span>
              <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
                浏览与选择目录 (Browse Folders)
              </h3>
            </div>
            <Dialog.Close className="border-2 border-line bg-canvas px-1.5 py-0.5 font-mono text-xs font-bold hover:bg-canvas-subtle hover:text-accent">
              ✕
            </Dialog.Close>
          </div>

          {/* Quick Bar & Breadcrumbs */}
          <div className="border-b border-line/80 bg-canvas-subtle/50 p-2.5 space-y-2 font-mono text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={!parentPath || loading}
                onClick={() => parentPath && loadDirectory(parentPath)}
                className="inline-flex items-center gap-1 border border-line bg-canvas px-2 py-1 text-[11px] font-semibold hover:bg-canvas-subtle disabled:opacity-40"
                title="返回上一级目录"
              >
                <span>⬆</span>
                <span>上一级</span>
              </button>
              {homePath && (
                <button
                  type="button"
                  onClick={() => loadDirectory(homePath)}
                  className="inline-flex items-center gap-1 border border-line bg-canvas px-2 py-1 text-[11px] font-semibold hover:bg-canvas-subtle"
                  title="转到家目录 (~)"
                >
                  <span>🏠</span>
                  <span>主目录</span>
                </button>
              )}
              {homePath && (
                <button
                  type="button"
                  onClick={() => loadDirectory(`${homePath}/Desktop`)}
                  className="inline-flex items-center gap-1 border border-line bg-canvas px-2 py-1 text-[11px] font-semibold hover:bg-canvas-subtle"
                  title="转到桌面目录"
                >
                  <span>💻</span>
                  <span>桌面</span>
                </button>
              )}
              <div className="ml-auto">
                <button
                  type="button"
                  disabled={isPickingNative}
                  onClick={handlePickNative}
                  className="inline-flex items-center gap-1 border border-line bg-canvas px-2 py-1 text-[11px] font-semibold text-accent hover:bg-canvas-subtle hover:border-accent disabled:opacity-50"
                  title="使用系统原生文件选择窗口选择目录"
                >
                  <span>🖥️</span>
                  <span>{isPickingNative ? "选择中..." : "系统选择器"}</span>
                </button>
              </div>
            </div>

            {/* Path Breadcrumbs */}
            <div className="flex items-center gap-1 overflow-x-auto rounded border border-line/60 bg-canvas px-2 py-1 text-[11px] thin-scroll">
              <button
                type="button"
                onClick={() => loadDirectory("/")}
                className="text-faint hover:text-accent font-bold px-0.5"
              >
                /
              </button>
              {pathSegments.map((segment, index) => {
                const segPath = "/" + pathSegments.slice(0, index + 1).join("/");
                const isLast = index === pathSegments.length - 1;
                return (
                  <div key={segPath} className="flex items-center gap-1 shrink-0">
                    <span className="text-faint">/</span>
                    <button
                      type="button"
                      onClick={() => loadDirectory(segPath)}
                      className={`px-0.5 rounded ${
                        isLast ? "font-bold text-accent" : "text-ink hover:text-accent"
                      }`}
                    >
                      {segment}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Search Filter */}
            <div>
              <input
                type="text"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="在此文件夹中过滤搜索..."
                className="w-full border border-line bg-canvas px-2 py-1 font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-accent"
              />
            </div>
          </div>

          {/* Directory Content List */}
          <div className="flex-1 overflow-y-auto p-2 font-mono text-xs thin-scroll">
            {loading && (
              <div className="py-8 text-center text-faint">
                <span className="inline-block animate-spin mr-1.5">⏳</span> 正在读取目录内容...
              </div>
            )}

            {!loading && error && (
              <div className="p-3 rounded border border-red-600/30 bg-red-500/10 text-red-600 text-xs">
                ❌ {error}
              </div>
            )}

            {!loading && !error && filteredItems.length === 0 && (
              <div className="py-8 text-center text-faint">
                {filterQuery ? "未找到匹配的子文件夹" : "当前目录下没有子文件夹"}
              </div>
            )}

            {!loading && !error && filteredItems.length > 0 && (
              <div className="grid grid-cols-1 gap-1">
                {filteredItems.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => loadDirectory(item.path)}
                    className="flex items-center justify-between border border-line/50 bg-canvas px-2.5 py-1.5 text-left transition hover:border-accent hover:bg-canvas-subtle group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-accent text-sm">📁</span>
                      <span className="truncate font-semibold text-ink group-hover:text-accent">
                        {item.name}
                      </span>
                      {item.isGitRepo && (
                        <span className="rounded bg-accent/10 px-1 py-0.2 text-[10px] text-accent font-normal">
                          🌿 Git
                        </span>
                      )}
                    </div>
                    <span className="text-faint text-[10px] group-hover:text-accent">进入 ➔</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t-2 border-line bg-canvas-subtle px-3 py-2 font-mono text-xs">
            <div className="truncate max-w-[280px] sm:max-w-xs text-[11px] text-faint" title={currentPath}>
              <span className="font-bold text-ink">当前路径: </span>
              <span className="text-accent font-semibold">{currentPath || "/"}</span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="border-2 border-line bg-canvas px-3 py-1 font-bold hover:bg-canvas-subtle"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!currentPath || loading}
                onClick={() => {
                  if (currentPath) {
                    onSelect(currentPath);
                    onOpenChange(false);
                  }
                }}
                className="border-2 border-line bg-accent px-4 py-1 font-bold text-white shadow-[2px_2px_0_var(--color-line)] transition hover:opacity-90 disabled:opacity-50 active:translate-x-0.5 active:translate-y-0.5 active:shadow-none"
              >
                选择此目录
              </button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
