import { Menu } from "@base-ui-components/react/menu";
import { useState } from "react";
import type { AgentRole } from "../../shared/protocol";
import { chatClient, useChat } from "../lib/chat";
import { RolesDialog } from "./RolesDialog";

const ROLES: { id: AgentRole; name: string; tag: string; description: string }[] = [
  {
    id: "coordinator",
    name: "统筹者 (Coordinator)",
    tag: "COORDINATOR",
    description: "需求拆解与多智能体任务派发，不直接写代码",
  },
  {
    id: "default",
    name: "标准模式 (Standard)",
    tag: "STANDARD",
    description: "单 Agent 全功能开发模式",
  },
];

export function RoleSelector() {
  const { snapshot } = useChat();
  const [rolesOpen, setRolesOpen] = useState(false);
  const activeRole: AgentRole = snapshot?.activeRole ?? "coordinator";
  const current = ROLES.find((r) => r.id === activeRole) ?? ROLES[0];

  const isCoordinator = activeRole === "coordinator";

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className={`flex h-7.5 items-center gap-1.5 border-2 px-2.5 font-mono text-xs font-bold transition-all shadow-[var(--pixel-shadow-sm)] hover:translate-x-[1px] hover:translate-y-[1px] ${
            isCoordinator
              ? "border-accent bg-bubble text-accent hover:border-purple-600"
              : "border-line-bright bg-card text-muted hover:border-accent hover:text-ink"
          }`}
          title={`当前角色: ${current.name} - ${current.description}`}
        >
          <span
            className={`size-2 border ${
              isCoordinator ? "border-accent bg-accent" : "border-muted bg-transparent"
            }`}
          />
          <span className="truncate max-w-[120px] sm:max-w-none">{current.tag}</span>
          <svg viewBox="0 0 20 20" className="size-3 fill-current opacity-60">
            <path d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="start">
            <Menu.Popup className="w-72 border-2 border-accent bg-card py-1.5 font-mono shadow-[var(--pixel-shadow)] outline-none z-50">
              <Menu.Group>
                <Menu.GroupLabel className="px-3 pt-1 pb-1 text-[10px] font-bold tracking-wide text-faint uppercase">
                  会话运行模式与角色
                </Menu.GroupLabel>
                {ROLES.map((r) => (
                  <Menu.Item
                    key={r.id}
                    closeOnClick
                    onClick={() => chatClient.setSessionRole(r.id)}
                    className="flex cursor-pointer flex-col gap-0.5 px-3 py-2 text-xs text-ink outline-none data-[highlighted]:bg-hover hover:bg-hover"
                  >
                    <div className="flex items-center justify-between">
                      <span className={`font-bold ${activeRole === r.id ? "text-accent" : "text-ink"}`}>
                        {r.name}
                      </span>
                      {activeRole === r.id && (
                        <span className="border border-accent bg-bubble px-1.5 py-0.2 text-[9px] font-bold text-accent">
                          ACTIVE
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-faint leading-tight">{r.description}</span>
                  </Menu.Item>
                ))}

                <div className="my-1 border-t border-line" />

                <Menu.Item
                  onClick={() => setRolesOpen(true)}
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-accent font-bold outline-none data-[highlighted]:bg-hover hover:bg-hover"
                >
                  <span className="text-sm">👥</span>
                  <span>角色看板与详细配置…</span>
                </Menu.Item>
              </Menu.Group>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <RolesDialog open={rolesOpen} onOpenChange={setRolesOpen} />
    </>
  );
}
