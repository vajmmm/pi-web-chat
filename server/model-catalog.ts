/**
 * Best-effort, bounded refresh of the official model catalog against a live
 * ModelRuntime. pi-web-chat runs standalone: it must be able to populate and
 * refresh its model catalog over the network without a prior `pi` CLI run
 * having written the local models-store cache.
 *
 * Contract (fail-open):
 * - never rejects: network failures, timeouts, and runtimes without refresh
 *   support are contained here;
 * - callers keep serving the previously cached catalog snapshot;
 * - `allowNetwork` is always true; `force` selects between provider
 *   freshness-throttled refresh (GET, startup) and an immediate refresh
 *   (explicit force endpoint).
 */

/** Bound for the freshness-throttled refresh performed by GET /api/models. */
export const DEFAULT_CATALOG_REFRESH_TIMEOUT_MS = 10_000;
/** Bound for the explicit force refresh performed by POST /api/models/refresh. */
export const DEFAULT_FORCE_CATALOG_REFRESH_TIMEOUT_MS = 20_000;
/** Bound for the fire-and-forget startup catalog refresh. */
export const STARTUP_CATALOG_REFRESH_TIMEOUT_MS = 20_000;

/** Structural subset of ModelRuntime.refresh (keeps mocks and typing decoupled). */
export interface CatalogRefreshableRuntime {
  refresh(options?: {
    allowNetwork?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
}

export interface ModelCatalogRefreshOutcome {
  /** refresh() completed without rejecting (per-provider errors may remain). */
  completed: boolean;
  /** refresh() reported an aborted (e.g. timed-out) refresh. */
  aborted: boolean;
  /** Per-provider errors reported by refresh(). */
  errors: ReadonlyMap<string, Error>;
}

export async function refreshModelCatalog(
  runtime: CatalogRefreshableRuntime,
  options: { force: boolean; timeoutMs?: number },
): Promise<ModelCatalogRefreshOutcome> {
  const timeoutMs =
    options.timeoutMs ??
    (options.force
      ? DEFAULT_FORCE_CATALOG_REFRESH_TIMEOUT_MS
      : DEFAULT_CATALOG_REFRESH_TIMEOUT_MS);
  try {
    const result = await runtime.refresh({
      allowNetwork: true,
      force: options.force,
      signal: AbortSignal.timeout(timeoutMs),
    });
    for (const [providerId, error] of result.errors) {
      console.warn(`[server] model catalog refresh failed for ${providerId}:`, error);
    }
    return { completed: true, aborted: result.aborted, errors: result.errors };
  } catch (err) {
    console.warn("[server] model catalog refresh failed; serving cached models:", err);
    return { completed: false, aborted: false, errors: new Map() };
  }
}

/**
 * Fire-and-forget startup catalog refresh. Returns a promise that settles when
 * the refresh completes, but the caller is expected NOT to await it: the HTTP
 * server must start listening immediately while the catalog refreshes in the
 * background. Non-force, so provider freshness throttling is respected.
 */
export function startBackgroundCatalogRefresh(
  runtime: CatalogRefreshableRuntime,
  timeoutMs: number = STARTUP_CATALOG_REFRESH_TIMEOUT_MS,
): Promise<ModelCatalogRefreshOutcome> {
  const pending = refreshModelCatalog(runtime, { force: false, timeoutMs });
  // refreshModelCatalog never rejects; guard the background path against any
  // future regression surfacing as an unhandled rejection.
  void pending.catch(() => {});
  return pending;
}
