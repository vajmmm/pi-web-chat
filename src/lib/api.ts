import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RoleConfig,
  UICustomModelsResponse,
  UICustomProvider,
  UICwdValidateResponse,
  UIExtensionsResponse,
  UIForkPoint,
  UIFsListResponse,
  UILLMTurnsResponse,
  UIModel,
  UIPickDirectoryResponse,
  UIProjectItem,
  UIPromptInspection,
  UISessionFileResponse,
  UISessionInfo,
  UISkillsResponse,
  UISubscriptionModelsResponse,
  UIToolItem,
} from "../../shared/protocol";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const SESSIONS_QUERY_KEY = ["sessions"] as const;
export const PROJECTS_QUERY_KEY = ["projects"] as const;

export function useProjects(enabled = true) {
  return useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: () => fetchJson<UIProjectItem[]>("/api/projects"),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useInvalidateProjects() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
    qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  };
}

export async function deleteSessionApi(sessionId: string, cwd?: string): Promise<{ ok: boolean }> {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete session");
  return res.json() as Promise<{ ok: boolean }>;
}

export async function deleteProjectApi(cwd: string): Promise<{ ok: boolean; deletedCount: number }> {
  const url = `/api/projects?cwd=${encodeURIComponent(cwd)}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete project");
  return res.json() as Promise<{ ok: boolean; deletedCount: number }>;
}

export async function deleteFolderApi(folderPath: string): Promise<{ ok: boolean; deletedCount: number }> {
  const url = `/api/projects?folder=${encodeURIComponent(folderPath)}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete folder sessions");
  return res.json() as Promise<{ ok: boolean; deletedCount: number }>;
}

export function useSessions(enabled = true, cwd?: string) {
  return useQuery({
    queryKey: [...SESSIONS_QUERY_KEY, cwd ?? ""],
    queryFn: () =>
      fetchJson<UISessionInfo[]>(`/api/sessions${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useInvalidateSessions() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    qc.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
  };
}

export function useForkPoints(sessionId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["fork-points", sessionId],
    queryFn: () =>
      fetchJson<UIForkPoint[]>(`/api/fork-points?session=${encodeURIComponent(sessionId ?? "")}`),
    enabled: enabled && !!sessionId,
    staleTime: 0,
  });
}

export function useExtensions(enabled = true) {
  return useQuery({
    queryKey: ["extensions"],
    queryFn: () => fetchJson<UIExtensionsResponse>("/api/extensions"),
    enabled,
    staleTime: 0,
  });
}

export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => fetchJson<UIModel[]>("/api/models"),
    staleTime: 5 * 60_000,
  });
}

export const CUSTOM_MODELS_QUERY_KEY = ["custom-models"] as const;

export function useCustomModels(enabled = true) {
  return useQuery({
    queryKey: CUSTOM_MODELS_QUERY_KEY,
    queryFn: () => fetchJson<UICustomModelsResponse>("/api/custom-models"),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export async function saveCustomModels(
  providers: UICustomProvider[],
): Promise<UICustomModelsResponse> {
  const res = await fetch("/api/custom-models", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers }),
  });
  const json = (await res.json()) as UICustomModelsResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `save failed: ${res.status}`);
  return json;
}

export const ROLES_QUERY_KEY = ["roles"] as const;

export function useRolesConfig(enabled = true) {
  return useQuery({
    queryKey: ROLES_QUERY_KEY,
    queryFn: () => fetchJson<{ roles: RoleConfig[]; path: string }>("/api/roles"),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export async function saveRolesConfig(
  roles: RoleConfig[],
): Promise<{ roles: RoleConfig[]; path: string }> {
  const res = await fetch("/api/roles", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roles }),
  });
  const json = (await res.json()) as { roles: RoleConfig[]; path: string; error?: string };
  if (!res.ok) throw new Error(json.error ?? `save failed: ${res.status}`);
  return json;
}

export function useInvalidateRoles() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ROLES_QUERY_KEY });
}

export function useInvalidateModels() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["models"] });
}

export async function validateCwd(cwd: string): Promise<UICwdValidateResponse> {
  const res = await fetch("/api/cwd/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return res.json() as Promise<UICwdValidateResponse>;
}

export async function getHomeDir(): Promise<{ home: string }> {
  return fetchJson<{ home: string }>("/api/home");
}

export async function pickDirectoryApi(currentPath?: string): Promise<UIPickDirectoryResponse> {
  const res = await fetch("/api/fs/pick-dir", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPath }),
  });
  if (!res.ok) {
    return { ok: false, error: `请求失败: ${res.status}`, fallback: true };
  }
  return res.json() as Promise<UIPickDirectoryResponse>;
}

export async function listDirectoryApi(path?: string): Promise<UIFsListResponse> {
  const url = `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`;
  return fetchJson<UIFsListResponse>(url);
}

export function useDirectoryList(path?: string, enabled = true) {
  return useQuery({
    queryKey: ["fs-list", path ?? ""],
    queryFn: () => listDirectoryApi(path),
    enabled,
    staleTime: 0,
  });
}

export function usePromptInspection(sessionId?: string | null, enabled = true) {
  return useQuery({
    queryKey: ["prompt-inspection", sessionId ?? "current"],
    queryFn: () =>
      fetchJson<UIPromptInspection>(
        `/api/prompt-inspector${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`,
      ),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useAllTools() {
  return useQuery({
    queryKey: ["all-tools"],
    queryFn: () => fetchJson<UIToolItem[]>("/api/tools"),
    staleTime: 10_000,
  });
}

export function useSkills(cwd?: string, enabled = true) {
  return useQuery({
    queryKey: ["skills", cwd ?? ""],
    queryFn: async () => {
      const res = await fetch(`/api/skills${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
      if (!res.ok) throw new Error("Failed to fetch skills");
      const data = (await res.json()) as UISkillsResponse;
      return data.skills ?? [];
    },
    enabled,
    staleTime: 10_000,
  });
}

export function useSessionFile(
  sessionId?: string | null,
  enabled = true,
  refetchInterval: number | false = false,
) {
  return useQuery({
    queryKey: ["session-file", sessionId ?? "current"],
    queryFn: () =>
      fetchJson<UISessionFileResponse>(
        `/api/session-file${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`,
      ),
    enabled,
    staleTime: 0,
    refetchInterval,
  });
}

export function useLLMTurns(
  sessionId?: string | null,
  taskId?: string | null,
  enabled = true,
  refetchInterval: number | false = false,
) {
  const queryParam = taskId
    ? `?task=${encodeURIComponent(taskId)}`
    : sessionId
      ? `?session=${encodeURIComponent(sessionId)}`
      : "";
  return useQuery({
    queryKey: ["llm-turns", taskId ?? sessionId ?? "current"],
    queryFn: () => fetchJson<UILLMTurnsResponse>(`/api/llm-turns${queryParam}`),
    enabled,
    staleTime: 0,
    refetchInterval,
  });
}

export const SUBSCRIPTION_MODELS_QUERY_KEY = ["subscription-models"] as const;

export function useSubscriptionModels(enabled = true) {
  return useQuery({
    queryKey: SUBSCRIPTION_MODELS_QUERY_KEY,
    queryFn: () => fetchJson<UISubscriptionModelsResponse>("/api/subscription-models"),
    enabled,
    staleTime: 30_000,
  });
}

export function useInvalidateSubscriptionModels() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SUBSCRIPTION_MODELS_QUERY_KEY });
}

