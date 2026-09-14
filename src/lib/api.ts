import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type {
  RoleConfig,
  UICustomModel,
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
  UIRunningSessionsResponse,
  UIBatchDeleteSessionsResult,
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
  // Stable identity across renders: callers put this in effect deps
  // (e.g. useSessionListSync), so a fresh function per render would retrigger
  // invalidate -> refetch -> rerender -> invalidate forever.
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
    qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  }, [qc]);
}

export async function deleteSessionApi(sessionId: string, cwd?: string): Promise<{ ok: boolean }> {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete session");
  return res.json() as Promise<{ ok: boolean }>;
}

/**
 * Batch-delete multiple sessions in a single request. A 409 response carries a
 * partial-failure summary (ok:false + failedSessionIds), so it is returned
 * instead of thrown; only network / unexpected statuses reject.
 */
export async function deleteSessionsBatchApi(
  sessions: { id: string; cwd?: string }[],
): Promise<UIBatchDeleteSessionsResult> {
  const res = await fetch("/api/sessions/batch-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessions }),
  });
  if (res.status !== 200 && res.status !== 409) {
    throw new Error(`/api/sessions/batch-delete: ${res.status}`);
  }
  return res.json() as Promise<UIBatchDeleteSessionsResult>;
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
  // See useInvalidateProjects: must stay referentially stable so effects that
  // depend on it do not re-run on every render (invalidate/refetch loop).
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    qc.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
  }, [qc]);
}

export const RUNNING_SESSIONS_QUERY_KEY = ["running-sessions"] as const;

/**
 * Lightweight in-memory set of session ids that are actively running: the main
 * turn is streaming, or subagents / the coordinator are working for the
 * session. Polled by the session list to render a live "busy" spinner.
 */
export function useRunningSessions(enabled = true, refetchInterval: number | false = false) {
  return useQuery({
    queryKey: RUNNING_SESSIONS_QUERY_KEY,
    queryFn: () => fetchJson<UIRunningSessionsResponse>("/api/sessions/running"),
    enabled,
    staleTime: 0,
    refetchInterval,
  });
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

export function useExtensions(enabled = true, sessionId?: string | null) {
  return useQuery({
    queryKey: ["extensions", sessionId ?? "current"],
    queryFn: () => fetchJson<UIExtensionsResponse>(
      `/api/extensions${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`,
    ),
    enabled,
    staleTime: 0,
  });
}

export const MODELS_QUERY_KEY = ["models"] as const;

export function useModels() {
  return useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: () => fetchJson<UIModel[]>("/api/models"),
    staleTime: 5 * 60_000,
  });
}

export const ROLE_MODELS_QUERY_KEY = ["role-models"] as const;

/** Role/subagent model catalog, including providers that are not executable by the main session. */
export function useRoleModels(enabled = true) {
  return useQuery({
    queryKey: ROLE_MODELS_QUERY_KEY,
    queryFn: () => fetchJson<UIModel[]>("/api/models?scope=role"),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** POST /api/models/refresh: force a server-side catalog refresh, returns the same list shape as GET /api/models. */
export async function refreshModelsApi(): Promise<UIModel[]> {
  const res = await fetch("/api/models/refresh", { method: "POST" });
  if (!res.ok) throw new Error(`/api/models/refresh: ${res.status}`);
  return res.json() as Promise<UIModel[]>;
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
  return useCallback(() => qc.invalidateQueries({ queryKey: ROLES_QUERY_KEY }), [qc]);
}

export function useInvalidateModels() {
  const qc = useQueryClient();
  return useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: MODELS_QUERY_KEY }),
        qc.invalidateQueries({ queryKey: ROLE_MODELS_QUERY_KEY }),
      ]),
    [qc],
  );
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

export function useAllTools(sessionId?: string | null) {
  return useQuery({
    queryKey: ["all-tools", sessionId ?? "current"],
    queryFn: () => fetchJson<UIToolItem[]>(
      `/api/tools${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`,
    ),
    staleTime: 10_000,
  });
}

export function useSkills(cwd?: string, enabled = true, sessionId?: string | null) {
  return useQuery({
    queryKey: ["skills", cwd ?? "", sessionId ?? "current"],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      if (sessionId) params.set("session", sessionId);
      const query = params.toString();
      const res = await fetch(`/api/skills${query ? `?${query}` : ""}`);
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
  return useCallback(
    () => qc.invalidateQueries({ queryKey: SUBSCRIPTION_MODELS_QUERY_KEY }),
    [qc],
  );
}

export async function addSubscriptionProvider(
  provider: string,
  apiKey: string,
): Promise<UISubscriptionModelsResponse> {
  const res = await fetch("/api/subscription-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, apiKey }),
  });
  const json = (await res.json()) as UISubscriptionModelsResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `add provider failed: ${res.status}`);
  return json;
}

export async function deleteSubscriptionProvider(
  provider: string,
): Promise<UISubscriptionModelsResponse> {
  const res = await fetch("/api/subscription-models", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  const json = (await res.json()) as UISubscriptionModelsResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `delete provider failed: ${res.status}`);
  return json;
}

export async function hideSubscriptionModel(
  provider: string,
  modelId: string,
): Promise<UISubscriptionModelsResponse> {
  const res = await fetch("/api/subscription-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "hide_model", provider, modelId }),
  });
  const json = (await res.json()) as UISubscriptionModelsResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `hide model failed: ${res.status}`);
  return json;
}

export async function unhideSubscriptionModel(
  provider: string,
  modelId: string,
): Promise<UISubscriptionModelsResponse> {
  const res = await fetch("/api/subscription-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "unhide_model", provider, modelId }),
  });
  const json = (await res.json()) as UISubscriptionModelsResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `unhide model failed: ${res.status}`);
  return json;
}

export async function unhideAllSubscriptionModels(
  provider: string,
): Promise<UISubscriptionModelsResponse> {
  const res = await fetch("/api/subscription-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "unhide_all", provider }),
  });
  const json = (await res.json()) as UISubscriptionModelsResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `unhide all failed: ${res.status}`);
  return json;
}

export async function fetchRemoteCustomModels(params: {
  baseUrl: string;
  apiKey?: string;
  api?: string;
}): Promise<{ models: UICustomModel[] }> {
  const res = await fetch("/api/fetch-custom-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as { models: UICustomModel[]; error?: string };
  if (!res.ok) throw new Error(json.error ?? `fetch models failed: ${res.status}`);
  return json;
}
