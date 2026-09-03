import { LinearStore } from "./backends/linear.js";
import { MarkdownStore } from "./backends/markdown.js";
import {
  type ConfigOverrides,
  type ResolvedConfig,
  resolveConfig,
} from "./config.js";
import { AxiError } from "./errors.js";
import type { Store } from "./store.js";
import type { SuggestionGlobals } from "./suggestions.js";

/**
 * The resolved CLI context: the active backend Store plus the config that
 * selected it. The command layer only ever talks to `Store`, so swapping in
 * sqlite/remote backends (P2/P3) never touches arg parsing or rendering.
 */
export interface TasksContext {
  store: Store;
  config: ResolvedConfig;
  suggestionGlobals?: SuggestionGlobals;
}

export function resolveTasksContext(
  overrides: ConfigOverrides = {},
  suggestionGlobals?: SuggestionGlobals,
): TasksContext {
  const config = resolveConfig(overrides);

  return {
    store: createStore(config),
    config,
    ...(suggestionGlobals ? { suggestionGlobals } : {}),
  };
}

function createStore(config: ResolvedConfig): Store {
  if (config.backend === "markdown") {
    return new MarkdownStore({
      path: config.path,
      ...(config.archivePath ? { archivePath: config.archivePath } : {}),
    });
  }
  if (config.backend === "linear") {
    const linear = config.linear;
    if (!linear) {
      throw new AxiError(
        "The linear backend is selected but no [linear] config was resolved",
        "VALIDATION_ERROR",
        ['Add `[linear]` with `team` and `project` to .tasks.toml'],
      );
    }
    return new LinearStore({
      team: linear.team,
      project: linear.project,
      cacheTtl: linear.cacheTtl,
      // The mirror deliberately reuses the configured backlog path, so an
      // offline read degrades to exactly the file a markdown home would read.
      mirrorPath: linear.mirrorPath,
    });
  }
  throw new AxiError(
    `Unsupported backend "${config.backend}" - this build ships the markdown and linear backends`,
    "UNSUPPORTED",
    ['Set `backend = "markdown"` or `backend = "linear"` in .tasks.toml'],
  );
}

/** Narrow an optional context to a present one (the resolver always sets it). */
export function requireCtx(ctx: TasksContext | undefined): TasksContext {
  if (!ctx) {
    throw new AxiError("backlog context was not resolved", "UNKNOWN");
  }
  return ctx;
}
