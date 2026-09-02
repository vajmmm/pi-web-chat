import type { IncomingMessage } from "node:http";
import type { ModelRuntime, CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import type { SessionRegistry } from "../session/session-registry.ts";
import type { SubagentManager } from "../subagent-manager.ts";
import type { UICustomProvider } from "../../shared/protocol.ts";

export interface ServerContext {
  sessionRegistry: SessionRegistry;
  subagentManager: SubagentManager;
  getModelRuntime: () => ModelRuntime;
  get modelRuntime(): ModelRuntime;
  homeDir: string;
  agentCwd: string;
  distDir: string;
  packageVersion: string;
  createRuntime: CreateAgentSessionRuntimeFactory;
  reloadModelProviders: (providers: UICustomProvider[]) => Promise<string | undefined>;
  updateModelRuntime: (newRuntime: ModelRuntime) => void;
}

export function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
