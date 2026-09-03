import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileSafe } from "./backends/lock.js";
import { AxiError } from "./errors.js";

/**
 * Backend + path resolution (report §8 config selection).
 *
 * Override order:
 *   --backend / --file flag > TASKS_AXI_* env > project .tasks.toml >
 *   ~/.tasks-axi/config.toml > defaults (markdown, first existing
 *   backlog.md/data/backlog.md, otherwise backlog.md).
 *
 * P1 ships only the markdown backend; the Store seam keeps sqlite/remote
 * additions invisible to the CLI layer.
 */

export interface ResolvedConfig {
  backend: string;
  /** Markdown backlog path (resolved to an absolute path). */
  path: string;
  /** Optional archive path for pruned tasks (resolved to an absolute path). */
  archivePath?: string;
  doneKeep: number;
  /** Present when `backend = "linear"`; the Linear partition to operate on. */
  linear?: ResolvedLinearConfig;
}

/** The resolved `[linear]` table (report §8 config selection, ticket DEV-44). */
export interface ResolvedLinearConfig {
  /** Linear team key, e.g. `DEV`. */
  team: string;
  /** Linear project name that partitions this home's backlog. */
  project: string;
  /** Seconds a cached snapshot is served without any network request. */
  cacheTtl: number;
  /** Where the read-only markdown mirror is written (absolute path). */
  mirrorPath: string;
}

export interface ConfigOverrides {
  backend?: string;
  file?: string;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

interface TomlConfig {
  backend?: string;
  markdown?: {
    path?: string;
    archive?: string;
    done_keep?: number;
  };
  linear?: {
    team?: string;
    project?: string;
    cache_ttl?: number;
  };
}

/** Retained Done tasks when no config says otherwise. */
export const DEFAULT_KEEP = 10;
/** Short enough that a stale read self-heals, long enough to cover a read loop. */
const DEFAULT_CACHE_TTL = 60;
const PATH_CANDIDATES = ["backlog.md", "data/backlog.md"];
type ConfigTable = "root" | "markdown" | "linear" | "unsupported";

/**
 * Minimal TOML reader for the tiny config surface we need: a top-level
 * `backend` key, a `[markdown]` table with `path` / `archive` / `done_keep`,
 * and a `[linear]` table with `team` / `project` / `cache_ttl`.
 * `archive` points at the file that receives pruned tasks.
 * Intentionally not a general TOML parser.
 */
export function parseConfigToml(src: string): TomlConfig {
  const config: TomlConfig = {};
  let table: ConfigTable = "root";

  for (const rawLine of src.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (line === "") continue;

    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const name = section[1].trim();
      table =
        name === "markdown" || name === "linear"
          ? (name as ConfigTable)
          : "unsupported";
      continue;
    }

    if (table === "unsupported") continue;

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!kv) {
      throw new AxiError(
        "Invalid config line: expected `key = value`",
        "VALIDATION_ERROR",
        ["Use `key = value` assignments in .tasks.toml"],
      );
    }
    const key = kv[1];
    const source = configKeySource(table, key);
    if (!source) continue;
    const value = parseTomlValue(kv[2], source);

    if (table === "root") {
      config.backend = requireTomlString(value, source);
      continue;
    }
    if (table === "linear") {
      config.linear ??= {};
      if (key === "team") config.linear.team = requireTomlString(value, source);
      if (key === "project") {
        config.linear.project = requireTomlString(value, source);
      }
      if (key === "cache_ttl") {
        if (typeof value !== "number") {
          throw new AxiError(
            "linear.cache_ttl must be an integer number of seconds",
            "VALIDATION_ERROR",
            ["Set `[linear] cache_ttl = 60` in .tasks.toml"],
          );
        }
        config.linear.cache_ttl = value;
      }
      continue;
    }
    config.markdown ??= {};
    if (key === "path") config.markdown.path = requireTomlString(value, source);
    if (key === "archive")
      config.markdown.archive = requireTomlString(value, source);
    if (key === "done_keep") {
      if (typeof value !== "number") {
        throw new AxiError(
          "markdown.done_keep must be an integer",
          "VALIDATION_ERROR",
          ["Set `[markdown] done_keep = 10` in .tasks.toml"],
        );
      }
      config.markdown.done_keep = value;
    }
  }

  return config;
}

function stripTomlComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return raw.slice(0, i);
  }
  return raw;
}

function configKeySource(
  table: ConfigTable,
  key: string,
): string | undefined {
  if (table === "root" && key === "backend") return "backend";
  if (
    table === "markdown" &&
    (key === "path" || key === "archive" || key === "done_keep")
  ) {
    return `markdown.${key}`;
  }
  if (
    table === "linear" &&
    (key === "team" || key === "project" || key === "cache_ttl")
  ) {
    return `linear.${key}`;
  }
  return undefined;
}

function parseTomlValue(raw: string, source: string): string | number {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    if (!trimmed.endsWith(quote) || trimmed.length === 1) {
      throw new AxiError(
        `${source} has an unterminated quoted value`,
        "VALIDATION_ERROR",
      );
    }
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  throw new AxiError(`${source} has an invalid value`, "VALIDATION_ERROR");
}

function requireTomlString(value: string | number, source: string): string {
  if (typeof value === "string") return value;
  throw new AxiError(`${source} must be a quoted string`, "VALIDATION_ERROR");
}

function loadToml(path: string): TomlConfig {
  const src = readFileSafe(path);
  return src ? parseConfigToml(src) : {};
}

function resolveMarkdownPath(
  explicit: string | undefined,
  tomlPath: string | undefined,
  cwd: string,
): string {
  const chosen = explicit ?? tomlPath;
  if (chosen) return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);

  for (const candidate of PATH_CANDIDATES) {
    const full = resolve(cwd, candidate);
    if (existsSync(full)) return full;
  }
  return resolve(cwd, PATH_CANDIDATES[0]);
}

function validatePathValue(
  value: string | undefined,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new AxiError(`${source} must not be empty`, "VALIDATION_ERROR", [
      "Set it to a backlog path or remove the empty override",
    ]);
  }
  return value;
}

function validateDoneKeep(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AxiError(
      "markdown.done_keep must be a non-negative integer",
      "VALIDATION_ERROR",
      ["Set `[markdown] done_keep = 10` in .tasks.toml"],
    );
  }
  return value;
}

export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? process.cwd();
  const home = overrides.home ?? homedir();

  const homeToml = loadToml(join(home, ".tasks-axi", "config.toml"));
  const projectToml = loadToml(resolve(cwd, ".tasks.toml"));

  const explicitPath =
    overrides.file !== undefined
      ? validatePathValue(overrides.file, "--file")
      : env.TASKS_AXI_FILE !== undefined
        ? validatePathValue(env.TASKS_AXI_FILE, "TASKS_AXI_FILE")
        : undefined;
  const tomlPath =
    explicitPath !== undefined
      ? undefined
      : projectToml.markdown?.path !== undefined
        ? validatePathValue(projectToml.markdown.path, "markdown.path")
        : validatePathValue(homeToml.markdown?.path, "markdown.path");

  const backend =
    overrides.backend ??
    env.TASKS_AXI_BACKEND ??
    projectToml.backend ??
    homeToml.backend ??
    "markdown";

  const path = resolveMarkdownPath(explicitPath, tomlPath, cwd);

  const archive =
    projectToml.markdown?.archive !== undefined
      ? validatePathValue(projectToml.markdown.archive, "markdown.archive")
      : validatePathValue(homeToml.markdown?.archive, "markdown.archive");
  const doneKeep = validateDoneKeep(
    projectToml.markdown?.done_keep ??
      homeToml.markdown?.done_keep ??
      DEFAULT_KEEP,
  );

  const config: ResolvedConfig = { backend, path, doneKeep };
  if (archive) {
    config.archivePath = isAbsolute(archive) ? archive : resolve(cwd, archive);
  }
  if (backend === "linear") {
    config.linear = resolveLinearConfig(
      { ...homeToml.linear, ...projectToml.linear },
      env,
      path,
    );
  }
  return config;
}

/**
 * The `[linear]` table, with env overrides for the two addressing values so a
 * throwaway partition can be pointed at without editing the checked-in config.
 *
 * The mirror lives beside the configured backlog path: that path stays the
 * markdown file the read-only mirror is rendered into, so an offline `list`
 * degrades to exactly the file a markdown home would have read.
 */
function resolveLinearConfig(
  table: { team?: string; project?: string; cache_ttl?: number },
  env: NodeJS.ProcessEnv,
  mirrorPath: string,
): ResolvedLinearConfig {
  const team = (env.TASKS_AXI_LINEAR_TEAM ?? table.team ?? "").trim();
  const project = (env.TASKS_AXI_LINEAR_PROJECT ?? table.project ?? "").trim();
  if (!team || !project) {
    throw new AxiError(
      'The linear backend requires `[linear] team = "..."` and `project = "..."`',
      "VALIDATION_ERROR",
      [
        'Add `[linear]` with `team = "DEV"` and `project = "<home-name>"` to .tasks.toml',
        "Run `linear-axi teams` and `linear-axi projects --team <KEY>` to see the valid values",
      ],
    );
  }
  const cacheTtl = table.cache_ttl ?? DEFAULT_CACHE_TTL;
  if (!Number.isSafeInteger(cacheTtl) || cacheTtl < 0) {
    throw new AxiError(
      "linear.cache_ttl must be a non-negative integer number of seconds",
      "VALIDATION_ERROR",
      ["Set `[linear] cache_ttl = 60` in .tasks.toml"],
    );
  }
  return { team, project, cacheTtl, mirrorPath };
}
