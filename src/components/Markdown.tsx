import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

function remarkNoStrikethrough(this: unknown) {
  const data = (this as { data?: () => unknown }).data?.() as
    | Record<string, unknown>
    | undefined;
  const exts = data?.micromarkExtensions as Record<string, unknown>[] | undefined;
  if (exts) {
    for (const ext of exts) {
      const text = ext.text as Record<string, unknown> | undefined;
      if (text && Array.isArray(text["126"])) {
        const kept = (text["126"] as { name?: string }[]).filter(
          (t) => t?.name !== "strikethrough"
        );
        if (kept.length) text["126"] = kept;
        else delete text["126"];
      }
      const insideSpan = ext.insideSpan as Record<string, unknown> | undefined;
      if (insideSpan) {
        for (const key of Object.keys(insideSpan)) {
          const arr = insideSpan[key];
          if (Array.isArray(arr)) {
            const kept = (arr as { name?: string }[]).filter(
              (t) => t?.name !== "strikethrough"
            );
            if (kept.length) insideSpan[key] = kept;
            else delete insideSpan[key];
          }
        }
      }
      const attention = ext.attentionMarkers as Record<string, unknown> | undefined;
      if (attention) {
        for (const key of Object.keys(attention)) {
          const arr = attention[key];
          if (Array.isArray(arr)) {
            const kept = (arr as number[]).filter((c) => c !== 126);
            if (kept.length) attention[key] = kept;
            else delete attention[key];
          }
        }
      }
    }
  }
  return () => {};
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-neutral dark:prose-invert max-w-none text-[15px] leading-relaxed prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkNoStrikethrough]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          table: ({ node: _node, ...props }) => (
            <div className="overflow-x-auto">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
