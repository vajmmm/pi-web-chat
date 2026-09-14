/**
 * rehype-highlight-lite
 *
 * A drop-in replacement for the `rehype-highlight` transform that only bundles
 * a curated subset of highlight.js grammars.
 *
 * Why: `rehype-highlight` statically imports lowlight's `common` grammar map
 * (37 languages) and uses it as the default, so the whole grammar set is always
 * emitted regardless of the `languages` option. Registering our own subset via
 * `createLowlight` keeps the bundle small while preserving identical behavior
 * for the languages we do ship (hljs classes, prefix, no auto-detection).
 *
 * Transform logic mirrors rehype-highlight (MIT, Titus Wormer) for parity.
 */
import type { Element, ElementContent, Root } from "hast";
import { createLowlight } from "lowlight";
import type { VFile } from "vfile";

import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** Curated grammar subset (covers js/ts/json/bash/python + common web/systems). */
const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  php,
  python,
  ruby,
  rust,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

const PREFIX = "hljs-";
const lowlight = createLowlight(LANGUAGES);

/** Concatenate the raw text of a code element (equivalent to toText for code). */
function toPlainText(node: Element): string {
  let out = "";
  const walk = (n: ElementContent) => {
    if (n.type === "text") {
      out += n.value;
    } else if ("children" in n && Array.isArray(n.children)) {
      for (const child of n.children) walk(child as ElementContent);
    }
  };
  for (const child of node.children) walk(child as ElementContent);
  return out;
}

function languageOf(node: Element): string | false | undefined {
  const list = node.properties.className;
  if (!Array.isArray(list)) return undefined;
  let name: string | undefined;
  for (const raw of list) {
    const value = String(raw);
    if (value === "no-highlight" || value === "nohighlight") return false;
    if (!name && value.slice(0, 5) === "lang-") name = value.slice(5);
    if (!name && value.slice(0, 9) === "language-") name = value.slice(9);
  }
  return name;
}

function highlightCode(node: Element, file: VFile) {
  const lang = languageOf(node);
  // No auto-detection: only highlight explicit `language-*` / `lang-*` blocks.
  if (lang === false || !lang) return;

  if (!Array.isArray(node.properties.className)) node.properties.className = [];
  const classes = node.properties.className as Array<string | number>;
  if (!classes.includes("hljs")) classes.unshift("hljs");

  const text = toPlainText(node);
  let result;
  try {
    result = lowlight.highlight(lang, text, { prefix: PREFIX });
  } catch (error) {
    if (/Unknown language/.test((error as Error).message)) {
      file.message(`Cannot highlight as \`${lang}\`, it’s not registered`);
      return;
    }
    throw error;
  }

  if (result.children.length > 0) {
    node.children = result.children as ElementContent[];
  }
}

function visitElements(parent: Root | Element, file: VFile) {
  const children = parent.children;
  if (!children) return;
  for (const child of children) {
    if (child.type !== "element") continue;
    if (
      child.tagName === "code" &&
      parent.type === "element" &&
      parent.tagName === "pre"
    ) {
      highlightCode(child, file);
    }
    visitElements(child, file);
  }
}

export function rehypeHighlightLite() {
  return (tree: Root, file: VFile) => {
    visitElements(tree, file);
  };
}
