import { Suspense, useState } from "react";
import { useMountedOnce } from "../lib/useMountedOnce";
import { LazyCwdSelectorDialog } from "./lazy-modals";

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
  const dialogMounted = useMountedOnce(open);

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

      {dialogMounted && (
        <Suspense fallback={null}>
          <LazyCwdSelectorDialog
            cwd={cwd}
            gitBranch={gitBranch}
            open={open}
            onOpenChange={setOpen}
            onSelectCwd={onSelectCwd}
          />
        </Suspense>
      )}
    </>
  );
}
