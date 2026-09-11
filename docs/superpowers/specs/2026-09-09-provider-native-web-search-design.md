# Provider-native web search in pi-web-chat

Date: 2026-09-09

## Goal

Coordinator and Researcher can call provider-native `web_search` (Codex / Grok / OpenAI Responses / Anthropic) without a separate search API key. Users do not need to `pi install npm:pi-web-search`.

## Non-goals

- `url_context` is not enabled, registered, or mentioned in prompts. Gemini in this app is reached through AGY (`provider: "agy"`), which is not Google's native URL Context API.
- No Brave / Tavily / Exa / DuckDuckGo backends.
- Developer, Verifier, and Standard Mode (`default`) do not get `web_search`.
- No new settings page, model picker change, or dedicated search UI.
- AGY models are out of scope. `pi-web-search` treats `provider: "agy"` as unsupported; the tool must return a clear error instead of switching models.

## Approach

Depend on npm package `pi-web-search` (currently 1.5.0). Load it through existing `extensionFactories` rather than vendoring its API clients.

Role `allowedTools` remains the only tool-permission source of truth.

## Loading

Add `pi-web-search` as a runtime dependency.

Create a thin wrapper (e.g. `server/web-search-extension.ts`) that:

1. Imports the package default export (`(pi: ExtensionAPI) => void`).
2. Passes a wrapped `ExtensionAPI` where:
   - `setActiveTools` is a no-op (the upstream extension rewrites active tools on `session_start` / `model_select` and would fight `applyRoleToSession`).
   - `registerTool` ignores `url_context` so that tool never appears in the session or Extensions dialog.
3. Forwards all other methods unchanged.

Mount the wrapper in:

- Coordinator session factories in `server/index.ts`.
- Subagent factories in `server/subagent/agent-runtime.ts` (needed so Researcher can search). Developer / Verifier still will not see the tool because it is not in their allowlist.

Production esbuild uses `packages: "external"`, so the package stays a `node_modules` runtime import. `pi-coding-agent` already depends on `@earendil-works/pi-tui`, which the extension imports.

## Permissions

`DEFAULT_ROLE_TOOLS`:

| Role | Change |
|---|---|
| coordinator | append `web_search` |
| researcher | append `web_search` |
| developer | unchanged |
| verifier | unchanged |
| default | unchanged |

Do not add `url_context` to any list.

## roles.json migration

Existing `~/.pi/agent/roles.json` stores explicit `allowedTools`. Updating `DEFAULT_ROLE_TOOLS` alone would not give current users the tool.

Follow the recovery-tools pattern: a one-time additive migration keyed on a prompt marker (e.g. `#### Web search` in Coordinator / Researcher instructions).

- If the marker is missing: append the marker block to instructions, and append `web_search` if absent.
- After the marker is persisted: do not re-add `web_search` if the user later removes it in the Roles UI.
- Do not bump `CURRENT_ROLE_DEFINITION_VERSION` (that would reset whole role definitions).

## Prompts

Coordinator: one short instruction that current-web lookup can use `web_search` directly; do not spawn a Researcher only to search.

Researcher: one short instruction that current docs, package versions, and external facts should use `web_search`, and cite returned sources.

No Gemini / URL Context wording.

## Runtime behavior

- Selected model is Codex (`openai-codex-responses`), xAI Grok (`xai` + `openai-responses`), OpenAI/Azure/Copilot Responses, or Anthropic Messages: `web_search` uses that provider's native search with existing Pi credentials.
- Unsupported model (including AGY Gemini): tool result is an error string; no silent fallback to another configured model.
- Optional upstream file `~/.pi/agent/web-search.json` remains available for users who want a dedicated search model; this app does not add UI for it.
- Frontend: existing expandable tool-call rendering is enough.

## Tests

- Coordinator / Researcher default `allowedTools` include `web_search`; Developer / Verifier / default do not.
- Migration adds `web_search` only when the prompt marker is missing; leaves an explicit post-migration tool list untouched.
- Wrapper: `setActiveTools` from the inner extension does not change the session tool list; `url_context` is not registered.
- Existing role / coordinator-boundary tests updated for the new default tool lists.

## Success

With Codex or Grok selected in the Web UI, Coordinator can search the live web in the main session, and a Researcher subagent can do the same. AGY Gemini sessions do not gain fake Google search. Switching models does not widen the role tool set.
