import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UISkillItem } from "../shared/protocol.ts";

const HOME = homedir();

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

  // 2. 项目级 skills (cwd/.agents/skills, cwd/.pi/skills)
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

export function loadSkillsContent(
  skillNames: string[],
  cwd?: string,
): Array<{ name: string; content: string }> {
  if (!skillNames || skillNames.length === 0) return [];
  const all = discoverAllSkills(cwd);
  const result: Array<{ name: string; content: string }> = [];

  for (const name of skillNames) {
    const item = all.find((s) => s.name === name);
    if (item) {
      const fullPath = item.path.startsWith("~") ? join(HOME, item.path.slice(1)) : item.path;
      const skillMd = join(fullPath, "SKILL.md");
      const targetFile = existsSync(skillMd) ? skillMd : fullPath.endsWith(".md") ? fullPath : null;
      if (targetFile && existsSync(targetFile)) {
        try {
          const raw = readFileSync(targetFile, "utf8");
          // 去除 YAML frontmatter，提取纯文本规约
          const clean = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
          result.push({ name, content: clean.trim() });
        } catch (e) {
          console.warn("[skills] Failed to read skill content:", targetFile, e);
        }
      }
    }
  }

  return result;
}

export function formatSelectedSkillsXml(skillNames: string[], cwd?: string): string {
  if (!skillNames || skillNames.length === 0) return "";
  const all = discoverAllSkills(cwd);
  const selected = all.filter((s) => skillNames.includes(s.name));
  if (selected.length === 0) return "";

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n",
    "<available_skills>",
  ];

  for (const s of selected) {
    const fullPath = s.path.startsWith("~") ? join(HOME, s.path.slice(1)) : s.path;
    const skillMd = join(fullPath, "SKILL.md");
    const loc = existsSync(skillMd) ? skillMd : fullPath;
    lines.push("  <skill>");
    lines.push(`    <name>${s.name}</name>`);
    lines.push(`    <description>${s.description}</description>`);
    lines.push(`    <location>${loc}</location>`);
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

