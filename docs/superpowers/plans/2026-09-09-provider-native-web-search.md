# Provider-native web search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coordinator and Researcher can call provider-native `web_search` via bundled `pi-web-search`, without `url_context` and without the extension rewriting the role tool allowlist.

**Architecture:** Wrap `pi-web-search`'s default factory so `setActiveTools` is a no-op and `url_context` is never registered. Mount the wrapper on coordinator and subagent sessions. Add `web_search` to Coordinator/Researcher `DEFAULT_ROLE_TOOLS` plus a one-time `#### Web search` prompt-marker migration.

**Tech Stack:** TypeScript, `pi-web-search` npm package, `@earendil-works/pi-coding-agent` `InlineExtension`, node:test.

## Global Constraints

- Do not register, allow, or prompt `url_context`.
- Role `allowedTools` remains the only permission source of truth.
- AGY models are unsupported; no silent model fallback.
- Use npm, not pnpm/yarn/bun.
- Do not bump `CURRENT_ROLE_DEFINITION_VERSION`.

---

### Task 1: Extension wrapper

**Files:**
- Create: `server/web-search-extension.ts`
- Test: `test/web-search-extension.test.ts`

**Interfaces:**
- Produces: `wrapProviderNativeWebSearchExtension(inner)`, `createWebSearchExtension()`, `URL_CONTEXT_TOOL`, `WEB_SEARCH_TOOL`

- [x] Wrapper tests and implementation
- [x] Real package registers `web_search` only

### Task 2: Role allowlist, prompts, migration

**Files:**
- Modify: `server/contracts/roles.ts`
- Modify: `test/contracts.test.ts`
- Modify: `test/coordinator-boundary.test.ts`

- [x] Default tools and prompt marker
- [x] One-time migration keyed on original instructions

### Task 3: Mount on coordinator and subagent runtimes

**Files:**
- Modify: `server/index.ts`
- Modify: `server/subagent/agent-runtime.ts`
- Modify: `package.json` (dependency `pi-web-search`)

- [x] `createWebSearchExtension()` in both `extensionFactories` lists
