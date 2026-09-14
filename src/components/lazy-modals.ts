import { lazy } from "react";

/**
 * Lazily-loaded heavy dialog/drawer components.
 *
 * These modules pull in `@base-ui-components/react/dialog` (plus markdown for
 * the subagent drawer). Declaring the `lazy()` references here keeps the
 * dynamic-import boundaries in one place so the app shell never has to import
 * the dialog implementation eagerly.
 */
export const LazyRolesDialog = lazy(() =>
  import("./RolesDialog").then((m) => ({ default: m.RolesDialog })),
);

export const LazyModelsDialog = lazy(() =>
  import("./ModelsDialog").then((m) => ({ default: m.ModelsDialog })),
);

export const LazyForkDialog = lazy(() =>
  import("./ForkDialog").then((m) => ({ default: m.ForkDialog })),
);

export const LazyExtensionsDialog = lazy(() =>
  import("./ExtensionsDialog").then((m) => ({ default: m.ExtensionsDialog })),
);

export const LazyLLMTurnsModal = lazy(() =>
  import("./LLMTurnsModal").then((m) => ({ default: m.LLMTurnsModal })),
);

export const LazyPromptInspectorModal = lazy(() =>
  import("./PromptInspectorModal").then((m) => ({ default: m.PromptInspectorModal })),
);

export const LazySubagentDrawer = lazy(() =>
  import("./SubagentDrawer").then((m) => ({ default: m.SubagentDrawer })),
);

export const LazyCwdSelectorDialog = lazy(() =>
  import("./CwdSelectorDialog").then((m) => ({ default: m.CwdSelectorDialog })),
);

export const LazySessionsDrawerDialog = lazy(() =>
  import("./SessionsDrawerDialog").then((m) => ({ default: m.SessionsDrawerDialog })),
);
