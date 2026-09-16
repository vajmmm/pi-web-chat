import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { UIMessage } from "../../shared/protocol";
import { useT } from "../lib/i18n";

/**
 * Message minimap (left-edge navigation bar) + hover preview.
 *
 * Design constraints:
 * - Only *user questions* produce lines (role === "user"); assistant/custom
 *   messages never do, and neither does the streaming bubble.
 * - The lines are a navigation *table of contents*: they are laid out in an
 *   evenly spaced flex column (fixed slots, adaptive compression) so their
 *   rendered position is decoupled from the document position. Long answers
 *   therefore never spread the lines apart.
 * - The document offset (`offsetTop`) of every user message is still cached so
 *   a line can jump to it and so the lines covered by the current viewport can
 *   be highlighted (multiple lines at once).
 * - The scroll container stays owned by MessageList (stick-to-bottom semantics).
 *   This component only *reads* the container and writes `scrollTop` on click.
 * - The overlay is `pointer-events-none`; pointer listeners are attached to the
 *   container itself and gated on `x <= HOT_ZONE_WIDTH`, so scrolling, selection
 *   and clicks in the message area are never intercepted. Hover hit-testing uses
 *   the *rendered* line centres, not the document offsets.
 * - Positions are cached during `rebuild()` (mount / message change /
 *   ResizeObserver). The scroll frame only reads `scrollTop` — no layout
 *   traversal — and active-line updates are rAF throttled.
 */

const LINE_WIDTH = 12; // px, uniform width for every line
const LINE_HOVER_WIDTH = 24; // px, expanded width while hovered (Codex-style)
const HOT_ZONE_WIDTH = 22; // px, the left strip that reacts to the pointer
const PREVIEW_CHAR_LIMIT = 200;
const TOP_PAD = 8; // px, keep the preview card off the container edges
const SLOT_HEIGHT = 10; // px, preferred vertical slot per line
const LINE_HEIGHT = 2; // px
const TRACK_PAD = 4; // px, keep the track clear of the container edges

interface MinimapLine {
  /** message array index (always a user message) */
  index: number;
  /** px offset of the message top within the scroll container (document space) */
  offsetTop: number;
}

/** Short, single-space preview text for the hover card. */
export function minimapPreviewText(
  m: UIMessage,
  imageLabel: string,
  emptyLabel: string,
): string {
  const parts: string[] = [];
  for (const b of m.content) {
    switch (b.type) {
      case "text":
        if (b.text.trim()) parts.push(b.text.trim());
        break;
      case "thinking":
        if (b.text.trim()) parts.push(`💭 ${b.text.trim()}`);
        break;
      case "toolCall":
        parts.push(`⚡ ${b.name}`);
        break;
      case "image":
        parts.push(imageLabel);
        break;
    }
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  const text = joined.length > 0 ? joined : emptyLabel;
  return text.length > PREVIEW_CHAR_LIMIT ? `${text.slice(0, PREVIEW_CHAR_LIMIT)}…` : text;
}

/**
 * Message indices whose user message top falls inside the current viewport
 * `[scrollTop, scrollTop + clientHeight]`. When no message top is inside the
 * viewport (e.g. scrolled into a long answer) the nearest message *before* the
 * viewport top is returned instead, so exactly the reading context is
 * highlighted. Returns multiple indices when several questions are visible.
 */
export function minimapActiveIndices(
  lines: readonly Pick<MinimapLine, "index" | "offsetTop">[],
  scrollTop: number,
  clientHeight: number,
): number[] {
  const bottom = scrollTop + clientHeight;
  const inView: number[] = [];
  for (const line of lines) {
    if (line.offsetTop >= scrollTop - 0.5 && line.offsetTop <= bottom) inView.push(line.index);
  }
  if (inView.length > 0) return inView;

  let nearest: Pick<MinimapLine, "index" | "offsetTop"> | null = null;
  for (const line of lines) {
    if (line.offsetTop <= scrollTop && (!nearest || line.offsetTop > nearest.offsetTop)) {
      nearest = line;
    }
  }
  return nearest ? [nearest.index] : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sameIndices(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** Message index of the rendered line whose centre is closest to `y`. */
function nearestLineIndex(
  lines: readonly MinimapLine[],
  centers: ReadonlyMap<number, number>,
  y: number,
): number | null {
  let best: MinimapLine | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const center = centers.get(line.index);
    if (center === undefined) continue;
    const distance = Math.abs(center - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = line;
    }
  }
  return best ? best.index : null;
}

export function MessageMinimap({
  containerRef,
  messages,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  messages: UIMessage[];
}) {
  const t = useT();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<MinimapLine[]>([]);
  const [active, setActive] = useState<ReadonlySet<number>>(() => new Set());
  const [containerHeight, setContainerHeight] = useState(0);
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null);
  const [cardHeight, setCardHeight] = useState(0);

  const linesRef = useRef<MinimapLine[]>([]);
  const lineCentersRef = useRef<Map<number, number>>(new Map());
  const geometryRef = useRef({ scrollHeight: 0, clientHeight: 0 });
  const rafRef = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  /** Recompute which user questions the viewport covers (cheap, rAF only). */
  const updateActive = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const clientHeight = geometryRef.current.clientHeight || container.clientHeight;
    const next = new Set(minimapActiveIndices(linesRef.current, container.scrollTop, clientHeight));
    setActive((prev) => (sameIndices(prev, next) ? prev : next));
  }, [containerRef]);

  const scheduleActive = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      updateActive();
    });
  }, [updateActive]);

  /**
   * Read the rendered *user* messages once and cache their document offset.
   * The rendered line positions stay independent of this.
   */
  const rebuild = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    geometryRef.current = { scrollHeight, clientHeight };
    setContainerHeight(clientHeight);

    const userMessages: { index: number; message: UIMessage }[] = [];
    messages.forEach((message, index) => {
      if (message.role === "user") userMessages.push({ index, message });
    });
    const containerRect = container.getBoundingClientRect();
    const nodeByIndex = new Map<number, HTMLElement>();
    container.querySelectorAll<HTMLElement>("[data-msg-index]").forEach((node) => {
      const index = Number(node.dataset.msgIndex);
      if (Number.isFinite(index)) nodeByIndex.set(index, node);
    });

    const next: MinimapLine[] = userMessages.map(({ index }, i) => {
      const node = nodeByIndex.get(index);
      const offsetTop = node
        ? node.getBoundingClientRect().top - containerRect.top + container.scrollTop
        : 0;
      return { index, offsetTop };
    });

    linesRef.current = next;
    setLines(next);
    updateActive();
  }, [containerRef, messages, updateActive]);

  // Rebuild on mount and whenever the message array changes.
  useEffect(() => {
    rebuild();
  }, [rebuild]);

  // Rebuild on container/content size changes (window resize, streaming growth).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => rebuild());
    observer.observe(container);
    const content = container.querySelector<HTMLElement>("[data-scroll-content]");
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [containerRef, rebuild]);

  // rAF-throttled scroll + resize fallback.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => scheduleActive();
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    scheduleActive();
    return () => {
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [containerRef, scheduleActive]);

  // Cache the rendered line centres (uniform layout) for hover hit-testing.
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const container = containerRef.current;
    const origin = (container ?? overlay).getBoundingClientRect().top;
    const centers = new Map<number, number>();
    overlay.querySelectorAll<HTMLElement>("[data-minimap-line]").forEach((el) => {
      const index = Number(el.dataset.msgIndexLine);
      if (!Number.isFinite(index)) return;
      const rect = el.getBoundingClientRect();
      centers.set(index, rect.top + rect.height / 2 - origin);
    });
    lineCentersRef.current = centers;
  }, [containerRef, lines, containerHeight]);

  // Pointer interaction: only the left hot zone reacts, the message area is untouched.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const clearHover = () => setHover((prev) => (prev === null ? prev : null));

    const onPointerMove = (event: PointerEvent) => {
      const lines = linesRef.current;
      if (lines.length === 0) {
        clearHover();
        return;
      }
      const rect = container.getBoundingClientRect();
      if (event.clientX - rect.left > HOT_ZONE_WIDTH) {
        clearHover();
        return;
      }
      const y = event.clientY - rect.top;
      const index = nearestLineIndex(lines, lineCentersRef.current, y);
      if (index === null) {
        clearHover();
        return;
      }
      setHover((prev) => (prev && prev.index === index && Math.abs(prev.y - y) < 1 ? prev : { index, y }));
    };

    const onPointerLeave = () => clearHover();

    const onClick = (event: MouseEvent) => {
      const lines = linesRef.current;
      if (lines.length === 0) return;
      const rect = container.getBoundingClientRect();
      if (event.clientX - rect.left > HOT_ZONE_WIDTH) return;
      const y = event.clientY - rect.top;
      const index = nearestLineIndex(lines, lineCentersRef.current, y);
      if (index === null) return;
      const line = lines.find((l) => l.index === index);
      if (!line) return;
      const { scrollHeight, clientHeight } = geometryRef.current;
      const maxScroll = Math.max(0, scrollHeight - clientHeight);
      container.scrollTop = clamp(line.offsetTop - TOP_PAD, 0, maxScroll);
    };

    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", onPointerLeave);
    container.addEventListener("click", onClick);
    return () => {
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
      container.removeEventListener("click", onClick);
    };
  }, [containerRef]);

  // Clear hover when the bound conversation changes.
  useEffect(() => {
    setHover(null);
  }, [messages]);

  const hovered = hover ? messages[hover.index] : undefined;

  // Measure the preview card so it can be clamped inside the viewport.
  useLayoutEffect(() => {
    if (!hovered || !cardRef.current) return;
    const height = cardRef.current.offsetHeight;
    setCardHeight((prev) => (Math.abs(prev - height) < 1 ? prev : height));
  }, [hovered]);

  if (messages.length === 0) return null;

  const imageLabel = t("imagePlaceholder");
  const emptyLabel = t("emptyMessage");

  // Evenly spaced slots, compressed to fit when there are more lines than the
  // container can hold at the preferred height.
  const available = Math.max(0, containerHeight - TRACK_PAD * 2);
  const slotHeight =
    lines.length > 0
      ? Math.max(LINE_HEIGHT, Math.min(SLOT_HEIGHT, available / lines.length))
      : SLOT_HEIGHT;

  const cardTop = hover
    ? clamp(
        hover.y - cardHeight / 2,
        TOP_PAD,
        Math.max(TOP_PAD, containerHeight - cardHeight - TOP_PAD),
      )
    : TOP_PAD;

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute top-0 bottom-0 left-0 hidden w-10 overflow-hidden md:block"
    >
      <div data-minimap-track className="flex h-full w-full flex-col justify-center pl-3">
        {lines.map((line) => {
          const isActive = active.has(line.index);
          const isHovered = hover?.index === line.index;
          return (
            <div
              key={line.index}
              data-minimap-slot
              className="flex w-full shrink-0 items-center"
              style={{ height: `${slotHeight}px` }}
            >
              <div
                data-minimap-line
                data-msg-index-line={line.index}
                data-role="user"
                data-active={isActive ? "1" : "0"}
                className={`h-[2px] rounded-full transition-all duration-150 ${
                  isHovered ? "bg-ink" : isActive ? "bg-ink/60" : "bg-ink/25"
                }`}
                style={{ width: `${isHovered ? LINE_HOVER_WIDTH : LINE_WIDTH}px` }}
              />
            </div>
          );
        })}
      </div>
      {hovered && (
        <div
          ref={cardRef}
          data-minimap-preview
          className="pointer-events-none absolute left-full ml-2 w-56 max-w-[70vw] rounded-lg border border-line bg-card/95 p-2.5 font-mono text-[11px] leading-snug text-ink shadow-[var(--pixel-shadow)]"
          style={{ top: `${cardTop}px` }}
        >
          <div className="mb-1 flex items-center gap-1.5">
            <span className="px-1 py-0.5 text-[9px] font-bold bg-accent/20 text-accent">
              {"USER"}
            </span>
          </div>
          <div className="line-clamp-3 whitespace-pre-wrap break-words text-muted">
            {minimapPreviewText(hovered, imageLabel, emptyLabel)}
          </div>
        </div>
      )}
    </div>
  );
}
