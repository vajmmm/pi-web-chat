import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import type { EffectiveRuntimePermission } from "./resolver.ts";

export interface ToolValidationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * 规范化真实物理路径解析：
 * 1. 若目标文件已存在，解析其 realpath；
 * 2. 若目标文件尚不存在，逐层向上查找其最近存在的祖先目录 (Nearest Existing Ancestor)，
 *    对其祖先解析 realpath 并拼接剩余路径，杜绝通过父级 symlink 逃逸未建文件。
 */
export function canonicalizePath(targetPath: string): string {
  const normalized = resolve(normalize(targetPath));
  if (existsSync(normalized)) {
    try {
      return realpathSync(normalized);
    } catch {
      return normalized;
    }
  }

  // 目标文件/路径尚不存在：逐层向上解析最近存在的祖先目录 realpath
  let curr = normalized;
  const tailParts: string[] = [];

  while (curr && curr !== dirname(curr)) {
    tailParts.unshift(basename(curr));
    curr = dirname(curr);
    if (existsSync(curr)) {
      try {
        const canonicalAncestor = realpathSync(curr);
        return resolve(canonicalAncestor, ...tailParts);
      } catch {
        return resolve(curr, ...tailParts);
      }
    }
  }

  return normalized;
}

/**
 * 规范化路径包含性检查：判断 targetPath 是否在 baseDir 目录范围内（处理 symlink 与 .. 逃逸）
 */
export function isPathContained(baseDir: string, targetPath: string): boolean {
  const canonicalBase = canonicalizePath(baseDir);
  const canonicalTarget = canonicalizePath(
    isAbsolute(targetPath) ? targetPath : resolve(baseDir, targetPath),
  );
  const rel = relative(canonicalBase, canonicalTarget);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 检查目标路径是否符合 glob 或路径模式规则
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  const normFile = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normPat = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normPat === "*" || normPat === "**" || normPat === "**/*") return true;

  // 使用占位符进行安全转换，防止级联替换损坏表达式
  const escaped = normPat.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const tokenGlobstarSlash = "___GLOBSTAR_SLASH___";
  const tokenSlashGlobstar = "___SLASH_GLOBSTAR___";
  const tokenGlobstar = "___GLOBSTAR___";
  const tokenSingleStar = "___SINGLE_STAR___";

  const tokenized = escaped
    .replace(/\*\*\/\*/g, tokenGlobstar)
    .replace(/\*\*\//g, tokenGlobstarSlash)
    .replace(/\/\*\*/g, tokenSlashGlobstar)
    .replace(/\*\*/g, tokenGlobstar)
    .replace(/\*/g, tokenSingleStar);

  const regexStr = tokenized
    .replace(new RegExp(tokenGlobstarSlash, "g"), "(?:.*/)?")
    .replace(new RegExp(tokenSlashGlobstar, "g"), "(?:/.*)?")
    .replace(new RegExp(tokenGlobstar, "g"), ".*")
    .replace(new RegExp(tokenSingleStar, "g"), "[^/]*");

  const regex = new RegExp(`^(?:${regexStr})$`);
  const baseName = normFile.replace(/^.*\//, "");
  return regex.test(normFile) || regex.test(baseName);
}

/**
 * 文件路径权限校验（运行时不进行拦截，全部放行）
 */
export function validateFilePathPermission(
  _permission: EffectiveRuntimePermission,
  _rawPath: string,
): ToolValidationResult {
  return { allowed: true };
}


/**
 * RuntimeEnforcer: 仅负责向 Session 传递当前角色的可用工具集 (setActiveToolsByName)，
 * 不在运行时挂载拦截钩子，也不拦截任何工具执行。
 * 权限与行为约束全部通过提示词 (System Prompt) + 工具集传入来完成。
 */
export class RuntimeEnforcer {
  /**
   * 将解析出的有效工具列表应用到 Agent Session（通过仅暴露允许的工具集来控制能力，不在运行时拦截）。
   */
  public static applyPermissionsToSession(
    session: any,
    permission: EffectiveRuntimePermission,
  ): void {
    if (typeof session?.setActiveToolsByName === "function") {
      let activeTools = [...permission.allowedTools];
      if (permission.disallowedTools && permission.disallowedTools.length > 0) {
        activeTools = activeTools.filter(
          (t) => !permission.disallowedTools!.includes(t),
        );
      }
      session.setActiveToolsByName(activeTools);
    }

    session._effectiveRuntimePermission = permission;
  }

  /**
   * 校验特定工具的执行请求（已移除运行时拦截，始终返回 allowed: true）
   */
  public static validateToolExecution(
    _permission: EffectiveRuntimePermission,
    _toolName: string,
    _params?: Record<string, unknown>,
  ): ToolValidationResult {
    return { allowed: true };
  }
}
