import { lazy, Suspense } from "react";

// The markdown + highlight.js stack is the single largest frontend dependency
// set. Load it on demand so it never enters the initial app-shell chunk.
const Markdown = lazy(() =>
  import("./Markdown").then((m) => ({ default: m.Markdown })),
);

function MarkdownFallback({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]">
      {text}
    </div>
  );
}

export function LazyMarkdown({ text }: { text: string }) {
  return (
    <Suspense fallback={<MarkdownFallback text={text} />}>
      <Markdown text={text} />
    </Suspense>
  );
}
