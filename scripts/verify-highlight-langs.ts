/**
 * Verifies the curated highlight.js subset used by rehype-highlight-lite:
 * common languages still highlight, and languages intentionally dropped from
 * the bundle fall back without crashing.
 *
 * Run: npx tsx scripts/verify-highlight-langs.ts
 */
import type { Element, Root } from "hast";
import type { VFile } from "vfile";
import { rehypeHighlightLite } from "../src/lib/rehype-highlight-lite.ts";

const transform = rehypeHighlightLite();

function codeTree(lang: string, code: string): Root {
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "code",
            properties: { className: [`language-${lang}`] },
            children: [{ type: "text", value: code }],
          },
        ],
      },
    ],
  };
}

function collectClasses(node: Root | Element): string[] {
  const out: string[] = [];
  const walk = (n: Root | Element) => {
    if (n.type === "element") {
      const cn = n.properties.className;
      if (Array.isArray(cn)) out.push(...cn.map(String));
    }
    const children = (n as Element).children;
    if (children) for (const c of children) if (c.type === "element") walk(c);
  };
  for (const c of node.children) if (c.type === "element") walk(c);
  return out;
}

function run(lang: string, code: string): { classes: string[]; messages: string[] } {
  const tree = codeTree(lang, code);
  const messages: string[] = [];
  transform(tree, { message: (m: string) => messages.push(m) } as unknown as VFile);
  return { classes: collectClasses(tree), messages };
}

const cases: Array<[string, string]> = [
  ["javascript", "const x = 1;\nfunction f() { return true; }"],
  ["typescript", "const x: number = 1;\ninterface A { a: string }"],
  ["json", '{ "a": 1, "b": [true, null] }'],
  ["bash", "#!/bin/bash\necho \"hi\" | grep hi"],
  ["python", "def f(x):\n    return x + 1"],
];

let failed = 0;
for (const [lang, code] of cases) {
  const { classes } = run(lang, code);
  const highlighted = classes.some((c) => c.startsWith("hljs-")) && classes.includes("hljs");
  console.log(
    `${highlighted ? "PASS" : "FAIL"}  ${lang.padEnd(11)} hljs spans: ${classes.filter((c) => c.startsWith("hljs-")).length}`,
  );
  if (!highlighted) failed++;
}

// Intentionally dropped grammar: must fall back gracefully (no throw).
{
  const { classes, messages } = run("objectivec", "@interface Foo\n@end");
  const graceful = messages.some((m) => /not registered/.test(m));
  const notHighlighted = !classes.some((c) => c.startsWith("hljs-"));
  console.log(
    `${graceful && notHighlighted ? "PASS" : "FAIL"}  objectivec  dropped grammar falls back (messages=${JSON.stringify(messages)})`,
  );
  if (!(graceful && notHighlighted)) failed++;
}

console.log(failed === 0 ? "\nall highlight checks passed" : `\n${failed} highlight checks failed`);
process.exit(failed === 0 ? 0 : 1);
