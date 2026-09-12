import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { UISkillItem } from "../shared/protocol.ts";

const HOME = homedir();
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function bundledSkillDirectories(): string[] {
  return [
    join(MODULE_DIR, ".pi", "skills"),
    join(MODULE_DIR, "..", ".pi", "skills"),
  ];
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const result: { name?: string; description?: string } = {};

  const nameMatch = block.match(/^name:\s*(.+)$/m);
  if (nameMatch) {
    result.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");
  }

  const descMatch = block.match(/^description:\s*([>|-]?)\s*\r?\n?([\s\S]*?)(?=\n\w+:|$)/m);
  if (descMatch) {
    const raw = descMatch[2] || "";
    result.description = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ");
  } else {
    const singleDesc = block.match(/^description:\s*(.+)$/m);
    if (singleDesc) {
      result.description = singleDesc[1].trim().replace(/^['"]|['"]$/g, "");
    }
  }

  return result;
}

export function scanSkillDirectory(dir: string, scope: "project" | "user"): UISkillItem[] {
  const items: UISkillItem[] = [];
  if (!existsSync(dir)) return items;

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      if (!existsSync(fullPath)) continue;
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        const skillMd = join(fullPath, "SKILL.md");
        if (existsSync(skillMd)) {
          const content = readFileSync(skillMd, "utf8");
          const meta = parseSkillFrontmatter(content);
          items.push({
            name: meta.name || entry,
            description: meta.description || "无描述",
            path: fullPath.startsWith(HOME) ? `~${fullPath.slice(HOME.length)}` : fullPath,
            scope,
          });
        }
      } else if (entry.endsWith(".md") && entry !== "README.md") {
        const content = readFileSync(fullPath, "utf8");
        const meta = parseSkillFrontmatter(content);
        const name = meta.name || entry.replace(/\.md$/, "");
        items.push({
          name,
          description: meta.description || "无描述",
          path: fullPath.startsWith(HOME) ? `~${fullPath.slice(HOME.length)}` : fullPath,
          scope,
        });
      }
    }
  } catch (err) {
    console.warn("[skills] Error scanning skill dir:", dir, err);
  }

  return items;
}

export function discoverAllSkills(cwd?: string): UISkillItem[] {
  const map = new Map<string, UISkillItem>();

  // 1. 全局 skills (~/.pi/agent/skills, ~/.agents/skills)
  const globalPaths = [
    join(HOME, ".pi", "agent", "skills"),
    join(HOME, ".agents", "skills"),
  ];
  for (const gp of globalPaths) {
    for (const s of scanSkillDirectory(gp, "user")) {
      map.set(s.name, s);
    }
  }

  // 2. 随 pi-web-chat 分发的 bundled skills。项目级 skill 随后覆盖它们。
  for (const bundledPath of bundledSkillDirectories()) {
    for (const s of scanSkillDirectory(bundledPath, "project")) {
      map.set(s.name, s);
    }
  }

  // 3. 项目级 skills (cwd/.agents/skills, cwd/.pi/skills)
  if (cwd) {
    const projectPaths = [
      join(cwd, ".agents", "skills"),
      join(cwd, ".pi", "skills"),
      join(cwd, ".pi", "agent", "skills"),
    ];
    for (const pp of projectPaths) {
      for (const s of scanSkillDirectory(pp, "project")) {
        // 项目级覆盖用户级同名 skill
        map.set(s.name, s);
      }
    }
  }

  return Array.from(map.values());
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  location: string;
}

function expandSkillPath(path: string): string {
  return path.startsWith("~") ? join(HOME, path.slice(1)) : path;
}

function skillFileLocation(item: UISkillItem): string {
  const fullPath = expandSkillPath(item.path);
  const skillMd = join(fullPath, "SKILL.md");
  return existsSync(skillMd) ? skillMd : fullPath;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Stable catalog location for Prompt Cache.
 * Project skills use a repo-relative logical path (e.g. `.agents/skills/foo/SKILL.md`).
 * User skills use a home-relative path. Never emit a worktree-specific absolute path.
 */
export function toStableSkillLocation(
  item: UISkillItem,
  cwd?: string,
  projectRoot?: string,
): string {
  const abs = skillFileLocation(item);
  for (const root of [cwd, projectRoot]) {
    if (!root) continue;
    const rel = relative(root, abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      return toPosixPath(rel);
    }
  }
  if (abs.startsWith(HOME)) {
    return toPosixPath(`~${abs.slice(HOME.length)}`);
  }
  return toPosixPath(abs);
}

/** Name, description, and readable path only. Never the SKILL.md body. */
export function resolveSkillCatalog(
  skillNames: string[],
  cwd?: string,
  projectRoot?: string,
): SkillCatalogEntry[] {
  if (!skillNames || skillNames.length === 0) return [];
  const byName = new Map(discoverAllSkills(cwd).map((item) => [item.name, item]));
  const catalog: SkillCatalogEntry[] = [];
  for (const name of skillNames) {
    const item = byName.get(name);
    if (!item) continue;
    catalog.push({
      name: item.name,
      description: item.description,
      location: toStableSkillLocation(item, cwd, projectRoot),
    });
  }
  return catalog;
}

export function formatSelectedSkillsXml(skillNames: string[], cwd?: string): string {
  const selected = resolveSkillCatalog(skillNames, cwd);
  if (selected.length === 0) return "";

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n",
    "<available_skills>",
  ];

  for (const s of selected) {
    lines.push("  <skill>");
    lines.push(`    <name>${s.name}</name>`);
    lines.push(`    <description>${s.description}</description>`);
    lines.push(`    <location>${s.location}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

export function adjustSkillsInBasePrompt(basePrompt: string, allowedSkills: string[], cwd?: string): string {
  // 先把已有的 <available_skills>...</available_skills> 及引导词完全移除
  const cleaned = basePrompt.replace(/\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/g, "");

  // 如果没有允许的 skill，直接返回纯净的 prompt
  if (!allowedSkills || allowedSkills.length === 0) {
    return cleaned;
  }

  // 如果有选中的 skill，按标准格式将选中的 skill 附加在结尾
  const xml = formatSelectedSkillsXml(allowedSkills, cwd);
  return xml ? `${cleaned}\n${xml}` : cleaned;
}
