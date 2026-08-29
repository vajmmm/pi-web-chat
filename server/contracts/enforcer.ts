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
 * 统一文件路径权限审查 (edit / write / bash 文件目标共享此判定规则)
 */
export function validateFilePathPermission(
  permission: EffectiveRuntimePermission,
  rawPath: string,
): ToolValidationResult {
  const baseDir = permission.worktreePath || permission.cwd || process.cwd();
  const canonicalBase = canonicalizePath(baseDir);
  const canonicalTarget = canonicalizePath(
    isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath),
  );

  // 1. 只读角色硬检查
  if (permission.writableScope === "none") {
    return {
      allowed: false,
      reason: `[RuntimeEnforcer] 当前角色 (${permission.profileId}) 为只读权限 (writableScope: none)，严禁创建或修改任何文件: ${rawPath}`,
    };
  }

  // 2. Symlink 逃逸与 Worktree 边界硬检查
  if (permission.writableScope === "worktree-only" && permission.worktreePath) {
    const contained = isPathContained(permission.worktreePath, canonicalTarget);
    if (!contained) {
      return {
        allowed: false,
        reason: `[RuntimeEnforcer] 路径越界或 Symlink 逃逸！当前任务运行在独立 Worktree 中 (writableScope: worktree-only)，严禁越界修改主工作区文件: ${rawPath}`,
      };
    }
  }

  const relFromBase = relative(canonicalBase, canonicalTarget).replace(/\\/g, "/");

  // 3. TaskContract scope exclude 检查 (最高排他优先级)
  if (permission.taskScope?.exclude && permission.taskScope.exclude.length > 0) {
    for (const exc of permission.taskScope.exclude) {
      if (matchesPattern(relFromBase, exc) || matchesPattern(rawPath, exc)) {
        return {
          allowed: false,
          reason: `[RuntimeEnforcer] 目标文件 "${rawPath}" 匹配 TaskContract.scope.exclude 规则 ("${exc}")，已被硬拦截修改。`,
        };
      }
    }
  }

  // 4. TaskContract scope include 检查 (白名单范围校验)
  if (
    permission.taskScope?.include &&
    permission.taskScope.include.length > 0 &&
    !permission.taskScope.include.includes("*") &&
    !permission.taskScope.include.includes("**")
  ) {
    const isIncluded = permission.taskScope.include.some(
      (inc) => matchesPattern(relFromBase, inc) || matchesPattern(rawPath, inc),
    );
    if (!isIncluded) {
      return {
        allowed: false,
        reason: `[RuntimeEnforcer] 目标文件 "${rawPath}" 不在 TaskContract.scope.include 明确允许的修改范围内，已被硬拦截。`,
      };
    }
  }

  // 5. test-only 检查
  if (permission.writableScope === "test-only") {
    const isTestPath =
      rawPath.includes("/test/") ||
      rawPath.includes("/__tests__/") ||
      rawPath.includes(".test.") ||
      rawPath.includes(".spec.") ||
      rawPath.includes("/mock/") ||
      rawPath.includes("/fixtures/") ||
      relFromBase.startsWith("test/") ||
      relFromBase.startsWith("__tests__/") ||
      relFromBase.startsWith("tests/");
    if (!isTestPath) {
      return {
        allowed: false,
        reason: `[RuntimeEnforcer] 测试者角色 (writableScope: test-only) 仅允许修改或创建测试/Mock相关文件，严禁修改生产业务路径: ${rawPath}`,
      };
    }
  }

  // 6. deploy-only 检查
  if (permission.writableScope === "deploy-only") {
    const isDeployPath =
      rawPath.includes("Dockerfile") ||
      rawPath.includes("docker-compose") ||
      rawPath.includes("deploy") ||
      rawPath.includes(".github/") ||
      rawPath.includes("k8s/") ||
      rawPath.includes("infra/");
    if (!isDeployPath) {
      return {
        allowed: false,
        reason: `[RuntimeEnforcer] 实施部署角色 (writableScope: deploy-only) 仅允许修改部署与发布相关配置，严禁修改业务源码: ${rawPath}`,
      };
    }
  }

  return { allowed: true };
}

/**
 * 从 bash 命令行中解析出所有潜在的文件写操作目标路径
 */
export function extractBashWriteTargets(command: string): Array<{ path: string; isWrite: boolean }> {
  const targets: Array<{ path: string; isWrite: boolean }> = [];
  const trimmed = command.trim();
  if (!trimmed) return targets;

  // 1. 匹配所有输出重定向目标 (> file, >> file, &> file, >| file, 2> file)
  const redirectRegex = /(?:>>?|&>|>\||2>>?)\s*([^\s;&|]+)/g;
  let match: RegExpExecArray | null;
  while ((match = redirectRegex.exec(trimmed)) !== null) {
    const dest = match[1].replace(/['"]/g, "").trim();
    if (dest && dest !== "/dev/null" && dest !== "&1" && dest !== "&2") {
      targets.push({ path: dest, isWrite: true });
    }
  }

  // 2. 匹配管道 tee 目标 (| tee file, | tee -a file)
  const teeRegex = /\|\s*tee\s+(?:-[a-zA-Z]+\s+)*([^\s;&|]+)/g;
  while ((match = teeRegex.exec(trimmed)) !== null) {
    const dest = match[1].replace(/['"]/g, "").trim();
    if (dest && dest !== "/dev/null") {
      targets.push({ path: dest, isWrite: true });
    }
  }

  // 3. 针对子命令分析写文件/修改文件的指令
  const segments = trimmed.split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/).map((t) => t.replace(/['"]/g, "").trim()).filter(Boolean);
    if (tokens.length === 0) continue;
    const rootBin = tokens[0].replace(/^[\/\\].*[\/\\]/, "");

    // 针对 touch, mkdir, rm, truncate, chmod, chown
    if (["touch", "mkdir", "rm", "truncate", "chmod", "chown"].includes(rootBin)) {
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token.startsWith("-") && token !== "|" && token !== ">" && token !== ">>") {
          targets.push({ path: token, isWrite: true });
        }
      }
    }

    // 针对 cp, mv 命令：最后一个非 flag 参数为写入目标路径
    if (rootBin === "cp" || rootBin === "mv") {
      const nonFlags = tokens.slice(1).filter((t) => !t.startsWith("-") && t !== "|" && t !== ">");
      if (nonFlags.length >= 2) {
        const dest = nonFlags[nonFlags.length - 1];
        targets.push({ path: dest, isWrite: true });
      }
    }

    // 针对 sed -i 原地修改
    if (rootBin === "sed" && tokens.some((t) => t.startsWith("-i") || t === "-i")) {
      const nonFlags = tokens.slice(1).filter((t) => !t.startsWith("-") && t !== "|" && t !== ">");
      if (nonFlags.length >= 2) {
        for (let i = 1; i < nonFlags.length; i++) {
          targets.push({ path: nonFlags[i], isWrite: true });
        }
      }
    }
  }

  return targets;
}

/**
 * 只读角色允许执行的安全命令/二进制列表 (Strict Read-Only Command Allowlist)
 */
const READONLY_COMMAND_ROOTS = new Set([
  "git",
  "cat",
  "ls",
  "head",
  "tail",
  "grep",
  "find",
  "rg",
  "wc",
  "diff",
  "echo",
  "which",
  "test",
  "[",
  "npm",
  "npx",
  "vitest",
  "jest",
  "pytest",
  "cargo",
  "go",
  "node",
  "tsc",
  "pwd",
  "date",
  "uname",
  "env",
]);

/**
 * Git 只读子命令白名单
 */
const GIT_READONLY_SUBCOMMANDS = new Set([
  "diff",
  "log",
  "status",
  "show",
  "branch",
  "rev-parse",
  "describe",
  "cat-file",
  "check-ignore",
  "ls-files",
  "tag",
  "stash",
  "remote",
]);

/**
 * 只读角色允许执行的只读 npm 命令
 */
const READONLY_NPM_SUBCOMMANDS = new Set([
  "test",
  "run test",
  "run check",
  "run typecheck",
  "run lint",
  "list",
  "view",
  "outdated",
  "audit",
]);

/**
 * 针对只读角色的确定性 Bash 命令安全检查
 */
function validateReadonlyBash(command: string): ToolValidationResult {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: true };

  // 1. 严格禁止任何重定向写入符号与管道 tee
  if (/>|>>|\|\s*tee\b|&>/.test(trimmed)) {
    return {
      allowed: false,
      reason: `[RuntimeEnforcer] 只读角色严禁通过 bash 输出重定向或 tee 写入文件: "${command}"`,
    };
  }

  // 2. 严格禁止文件创建、删除、移动、权限修改与原地 sed 修改
  if (/\b(rm|mv|cp|mkdir|touch|chmod|chown|truncate|sed\s+-[^\s]*i)\b/.test(trimmed)) {
    return {
      allowed: false,
      reason: `[RuntimeEnforcer] 只读角色严禁通过 bash 执行文件写入/删除/修改命令: "${command}"`,
    };
  }

  // 3. 严格禁止通过 node -e / python -c / bash -c 等动态 eval 执行代码
  if (/\b(node|python|python3|ruby|perl|bash|sh|zsh)\s+(-e|-c|--eval)\b/.test(trimmed)) {
    return {
      allowed: false,
      reason: `[RuntimeEnforcer] 只读角色严禁通过脚本解释器 eval 执行动态代码: "${command}"`,
    };
  }

  // 4. 针对多子命令 (&&, ;, ||) 逐项检查根命令与脚本副作用
  const segments = trimmed.split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const rootBin = tokens[0].replace(/^[\/\\].*[\/\\]/, "");

    // 检查根命令是否在只读白名单中
    if (!READONLY_COMMAND_ROOTS.has(rootBin)) {
      return {
        allowed: false,
        reason: `[RuntimeEnforcer] 命令 "${rootBin}" 未在只读角色的安全命令白名单中，已被硬拦截。`,
      };
    }

    // 针对 node/python 执行任意脚本文件产生副作用进行硬拦截
    if (rootBin === "node" || rootBin === "python" || rootBin === "python3") {
      const scriptArg = tokens.slice(1).find((t) => !t.startsWith("-") && (t.endsWith(".js") || t.endsWith(".ts") || t.endsWith(".py") || t.endsWith(".mjs") || t.endsWith(".cjs")));
      if (scriptArg) {
        return {
          allowed: false,
          reason: `[RuntimeEnforcer] 只读角色严禁通过 node/python 执行具有文件修改副作用的脚本文件 "${scriptArg}": "${command}"`,
        };
      }
    }

    // 针对 Git 检查是否为修改型子命令
    if (rootBin === "git") {
      let subcmdIndex = 1;
      while (subcmdIndex < tokens.length && tokens[subcmdIndex].startsWith("-")) {
        subcmdIndex++;
      }
      const subcmd = tokens[subcmdIndex] || "";
      if (subcmd && !GIT_READONLY_SUBCOMMANDS.has(subcmd)) {
        return {
          allowed: false,
          reason: `[RuntimeEnforcer] 只读角色严禁执行 git 变更子命令 "git ${subcmd}": "${command}"`,
        };
      }
    }

    // 针对 npm/pnpm/yarn 检查是否为变更或构建命令
    if (rootBin === "npm" || rootBin === "pnpm" || rootBin === "yarn") {
      const fullCmd = tokens.slice(1).join(" ");
      const subcmd = tokens[1] || "";
      if (["install", "add", "remove", "uninstall", "update", "publish", "run build", "build", "run dev", "run deploy", "deploy"].some((c) => fullCmd.startsWith(c) || subcmd === c)) {
        return {
          allowed: false,
          reason: `[RuntimeEnforcer] 只读角色严禁执行依赖或构建变更命令 "${rootBin} ${fullCmd}": "${command}"`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * 针对受限角色对 Bash 命令中涉及的所有文件写操作做全量路径校验
 */
function validateBashExecution(
  permission: EffectiveRuntimePermission,
  command: string,
): ToolValidationResult {
  // 1. 只读角色检查
  if (permission.writableScope === "none") {
    const readonlyCheck = validateReadonlyBash(command);
    if (!readonlyCheck.allowed) {
      return readonlyCheck;
    }
  }

  // 2. 拦截通过 cd 逃逸 worktree
  if (permission.writableScope === "worktree-only" && permission.worktreePath) {
    if (/\bcd\s+(\.\.|\/|~)/.test(command)) {
      return {
        allowed: false,
        reason: `[RuntimeEnforcer] 当前任务运行在独立 Worktree 中，严禁通过 cd 逃逸工作区: "${command}"`,
      };
    }
  }

  // 3. 提取命令中的所有文件写入目标，并严格执行 validateFilePathPermission 判定
  const writeTargets = extractBashWriteTargets(command);
  for (const target of writeTargets) {
    const check = validateFilePathPermission(permission, target.path);
    if (!check.allowed) {
      return {
        allowed: false,
        reason: `[RuntimeEnforcer Sandbox Violation] Bash 命令包含未授权的文件写操作目标 "${target.path}": ${check.reason}`,
      };
    }
  }

  // 4. 针对绝对路径与越界逃逸参数进行全量扫描 (针对 worktree-only / test-only / deploy-only)
  if (permission.writableScope === "worktree-only" && permission.worktreePath) {
    const tokens = command.split(/\s+/).map((t) => t.replace(/['"]/g, "").trim()).filter(Boolean);
    for (const token of tokens) {
      if (isAbsolute(token) && !token.startsWith("/dev/") && !token.startsWith("/proc/")) {
        if (!isPathContained(permission.worktreePath, token)) {
          // 如果该绝对路径出现在重定向或写命令中
          const isWriteContext = /(?:>>?|&>|>\||touch|mkdir|rm|cp|mv|sed)\b/.test(command);
          if (isWriteContext) {
            return {
              allowed: false,
              reason: `[RuntimeEnforcer Sandbox Violation] Bash 命令引用的绝对路径 "${token}" 超出了分配的 Worktree 目录 "${permission.worktreePath}"，已被硬沙箱拦截！`,
            };
          }
        }
      }
    }
  }

  return { allowed: true };
}

/**
 * RuntimeEnforcer: 运行时硬权限拦截器
 *
 * 保证即使 LLM 发生幻觉或提示词失效，底层工具与环境权限仍能实现确定性硬隔离。
 */
export class RuntimeEnforcer {
  /**
   * 将解析出的有效运行时权限应用到 Agent Session。
   * 单一 Enforcer 架构：每个 Session 仅安装一次拦截钩子，Role 切换只更新引用，绝不累积 wrapper！
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

    // 绑定当前最新的 EffectivePermission 到 Session 上
    session._effectiveRuntimePermission = permission;

    // 单一 Enforcer：仅首次注册 hook，后续角色切换直接读取 session._effectiveRuntimePermission
    if (session?.agent && !session._runtimeEnforcerHookInstalled) {
      session._runtimeEnforcerHookInstalled = true;
      const originalBeforeToolCall = session.agent.beforeToolCall;

      session.agent.beforeToolCall = async (context: any, signal?: AbortSignal) => {
        const currentPerm: EffectiveRuntimePermission = session._effectiveRuntimePermission;
        if (currentPerm) {
          const toolName = context.toolCall?.name || context.toolName;
          const args = context.args || context.input || {};

          const check = RuntimeEnforcer.validateToolExecution(currentPerm, toolName, args);
          if (!check.allowed) {
            return {
              block: true,
              reason: check.reason,
            };
          }
        }

        if (typeof originalBeforeToolCall === "function") {
          return await originalBeforeToolCall(context, signal);
        }
        return undefined;
      };
    }
  }

  /**
   * 校验特定工具的执行请求是否合法 (统一应用于 edit, write, bash)
   */
  public static validateToolExecution(
    permission: EffectiveRuntimePermission,
    toolName: string,
    params?: Record<string, unknown>,
  ): ToolValidationResult {
    // 1. 工具白名单检查
    if (!permission.allowedTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `[RuntimeEnforcer] 工具 '${toolName}' 未在当前角色权限白名单 (${permission.profileId}) 中，执行已被硬拦截。`,
      };
    }

    // 2. 工具黑名单检查
    if (permission.disallowedTools?.includes(toolName)) {
      return {
        allowed: false,
        reason: `[RuntimeEnforcer] 工具 '${toolName}' 在当前角色黑名单中，已被强制禁用。`,
      };
    }

    // 3. Bash 命令审查 (与 edit/write 共享 validateFilePathPermission 真实路径校验)
    if (toolName === "bash") {
      const command =
        (params?.command as string) ||
        (params?.cmd as string) ||
        (params?.CommandLine as string) ||
        "";

      return validateBashExecution(permission, command);
    }

    // 4. 写权限与路径校验 (针对 edit, write 等修改型工具)
    if (toolName === "edit" || toolName === "write") {
      const rawPath =
        (params?.path as string) ||
        (params?.file as string) ||
        (params?.TargetFile as string);

      if (rawPath) {
        return validateFilePathPermission(permission, rawPath);
      }
    }

    return { allowed: true };
  }
}
