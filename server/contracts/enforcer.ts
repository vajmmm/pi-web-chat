import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, relative, resolve } from "node:path";

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
