import { Menu } from "@base-ui-components/react/menu";
import type { UIThinkingLevel } from "../../shared/protocol";
import { chatClient } from "../lib/chat";

export function ThinkingMenu({
  current,
  levels,
}: {
  current: UIThinkingLevel;
  levels: UIThinkingLevel[];
}) {
  if (levels.length <= 1) return null;

  return (
    <Menu.Root>
      <Menu.Trigger
        className="flex items-center gap-1 border-2 border-line-bright bg-card px-2 py-1 font-mono text-xs font-bold text-ink shadow-[var(--pixel-shadow-sm)] transition-all hover:translate-x-[1px] hover:translate-y-[1px] hover:border-accent hover:bg-hover"
        title="Thinking level"
      >
        <span>🧠</span>
        <span>{current}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup className="w-36 border-2 border-accent bg-card py-1 font-mono shadow-[var(--pixel-shadow)] outline-none">
            {levels.map((level) => (
              <Menu.Item
                key={level}
                onClick={() => chatClient.send({ type: "set_thinking_level", level })}
                className={`cursor-pointer px-3 py-1.5 text-xs outline-none data-[highlighted]:bg-hover ${
                  level === current ? "bg-hover font-bold text-accent" : "text-ink"
                }`}
              >
                {level}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
