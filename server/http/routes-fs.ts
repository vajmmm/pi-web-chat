import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  UICwdValidateResponse,
  UIFsItem,
  UIFsListResponse,
  UIPickDirectoryResponse,
} from "../../shared/protocol.ts";
import { getCurrentGitBranch, resolveGitRepoRoot } from "../worktree.ts";
import { readBody, type ServerContext } from "./context.ts";

const execFileAsync = promisify(execFile);

export function shorten(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export async function pickDirectoryNative(home: string, startPath?: string): Promise<UIPickDirectoryResponse> {
  const platform = process.platform;
  const initial =
    startPath && existsSync(startPath) && statSync(startPath).isDirectory() ? resolve(startPath) : home;

  if (platform === "darwin") {
    const escaped = initial.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `set chosenFolder to choose folder with prompt "选择工作区目录:" default location (POSIX file "${escaped}")\nPOSIX path of chosenFolder`;
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      const picked = stdout.trim().replace(/\/+$/, "");
      if (picked && existsSync(picked)) {
        return { ok: true, path: picked };
      }
      return { ok: false, error: "未选择有效目录" };
    } catch (err: unknown) {
      const errorMsg = String(err);
      if (errorMsg.includes("User canceled") || errorMsg.includes("-128")) {
        return { ok: false, canceled: true };
      }
      return { ok: false, error: errorMsg, fallback: true };
    }
  }

  if (platform === "win32") {
    const escaped = initial.replace(/'/g, "''");
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "选择工作区目录"
$dialog.ShowNewFolderButton = $true
if (Test-Path '${escaped}') { $dialog.SelectedPath = '${escaped}' }
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
} else {
  exit 2
}
`;
    try {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        psScript,
      ]);
      const picked = stdout.trim();
      if (picked && existsSync(picked)) {
        return { ok: true, path: picked };
      }
      return { ok: false, error: "未选择有效目录" };
    } catch (err: unknown) {
      const errObj = err as { code?: number; message?: string };
      if (errObj.code === 2) {
        return { ok: false, canceled: true };
      }
      return { ok: false, error: String(err), fallback: true };
    }
  }

  if (platform === "linux") {
    try {
      const { stdout } = await execFileAsync("zenity", [
        "--file-selection",
        "--directory",
        `--filename=${initial}/`,
        "--title=选择工作区目录",
      ]);
      const picked = stdout.trim().replace(/\/+$/, "");
      if (picked && existsSync(picked)) {
        return { ok: true, path: picked };
      }
      return { ok: false, error: "未选择有效目录" };
    } catch (err: unknown) {
      const errorMsg = String(err);
      if (errorMsg.includes("1") || errorMsg.includes("cancelled")) {
        return { ok: false, canceled: true };
      }
      try {
        const { stdout } = await execFileAsync("kdialog", ["--getexistingdirectory", initial]);
        const picked = stdout.trim().replace(/\/+$/, "");
        if (picked && existsSync(picked)) {
          return { ok: true, path: picked };
        }
        return { ok: false, error: "未选择有效目录" };
      } catch {
        return { ok: false, error: "系统原生选择器不可用", fallback: true };
      }
    }
  }

  return { ok: false, error: "当前系统不支持原生目录选择器", fallback: true };
}

export async function handleFsRoutes(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<boolean> {
  const HOME = ctx.homeDir;

  if (url.pathname === "/api/home") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ home: HOME }));
    return true;
  }

  // 唤起原生目录选择器 (/api/fs/pick-dir)
  if (url.pathname === "/api/fs/pick-dir" && req.method === "POST") {
    const body = await readBody(req);
    let startPath: string | undefined;
    try {
      const parsed = JSON.parse(body) as { currentPath?: string };
      if (parsed.currentPath?.trim()) {
        const raw = parsed.currentPath.trim();
        startPath = raw.startsWith("~") ? join(HOME, raw.slice(1)) : raw;
      }
    } catch {
      /* ignore */
    }
    const result = await pickDirectoryNative(HOME, startPath);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  // 目录列表浏览 (/api/fs/list)
  if (url.pathname === "/api/fs/list") {
    const targetQuery = url.searchParams.get("path")?.trim() || HOME;
    const targetPath = targetQuery.startsWith("~") ? join(HOME, targetQuery.slice(1)) : targetQuery;
    const resolved = resolve(targetPath);

    if (!existsSync(resolved)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          currentPath: resolved,
          parentPath: dirname(resolved) !== resolved ? dirname(resolved) : null,
          homePath: HOME,
          items: [],
          error: "目录不存在",
        } satisfies UIFsListResponse),
      );
      return true;
    }

    try {
      const isDir = statSync(resolved).isDirectory();
      if (!isDir) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            currentPath: resolved,
            parentPath: dirname(resolved) !== resolved ? dirname(resolved) : null,
            homePath: HOME,
            items: [],
            error: "指定路径不是目录",
          } satisfies UIFsListResponse),
        );
        return true;
      }

      const entries = readdirSync(resolved, { withFileTypes: true });
      const items: UIFsItem[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") && entry.name !== ".pi") continue;
        const full = join(resolved, entry.name);
        const isGit = existsSync(join(full, ".git"));
        items.push({
          name: entry.name,
          path: full,
          isDirectory: true,
          isGitRepo: isGit,
        });
      }

      items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

      const resp: UIFsListResponse = {
        ok: true,
        currentPath: resolved,
        parentPath: dirname(resolved) !== resolved ? dirname(resolved) : null,
        homePath: HOME,
        items,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(resp));
      return true;
    } catch (err: unknown) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          currentPath: resolved,
          parentPath: dirname(resolved) !== resolved ? dirname(resolved) : null,
          homePath: HOME,
          items: [],
          error: `无法读取目录: ${String(err)}`,
        } satisfies UIFsListResponse),
      );
      return true;
    }
  }

  // 工作目录有效性校验 (/api/cwd/validate)
  if (url.pathname === "/api/cwd/validate") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return true;
    }
    const body = await readBody(req);
    try {
      const { cwd } = JSON.parse(body) as { cwd: string };
      const rawPath = cwd?.trim() || "";
      const targetPath = rawPath.startsWith("~") ? join(HOME, rawPath.slice(1)) : rawPath;
      const resolved = resolve(targetPath);

      if (!existsSync(resolved)) {
        const resp: UICwdValidateResponse = {
          ok: false,
          path: resolved,
          displayPath: shorten(resolved, HOME),
          name: basename(resolved),
          isGitRepo: false,
          error: "目录不存在",
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(resp));
        return true;
      }

      const isDir = statSync(resolved).isDirectory();
      if (!isDir) {
        const resp: UICwdValidateResponse = {
          ok: false,
          path: resolved,
          displayPath: shorten(resolved, HOME),
          name: basename(resolved),
          isGitRepo: false,
          error: "指定路径不是目录",
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(resp));
        return true;
      }

      const repoRoot = await resolveGitRepoRoot(resolved);
      const gitBranch = repoRoot ? (await getCurrentGitBranch(resolved)) ?? undefined : undefined;

      const resp: UICwdValidateResponse = {
        ok: true,
        path: resolved,
        displayPath: shorten(resolved, HOME),
        name: basename(resolved),
        isGitRepo: !!repoRoot,
        gitBranch,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(resp));
      return true;
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
      return true;
    }
  }

  return false;
}
