import type { Hold, State, Task, TaskLink } from "../model.js";
import { deriveLinks, leadingKind } from "./markdown-grammar.js";
import { parseDescription } from "./linear-meta.js";

/**
 * Mapping between a Linear issue and a tasks-axi `Task`.
 *
 * The load-bearing rule is that a workflow state is read by its **type**, never
 * by its display name. Linear lets a human rename `In Progress` to anything at
 * any moment, and every renameable state still reports one of a fixed set of
 * types, so type is the only stable key. This is why a home can add `PR Ready`
 * or rename `Todo` without tasks-axi noticing (ticket DEV-44 acceptance
 * criterion 2).
 */

/** Every state type Linear can report, mapped to a tasks-axi state. */
const STATE_BY_TYPE: Record<string, State> = {
  triage: "queued",
  backlog: "queued",
  unstarted: "queued",
  started: "in_flight",
  completed: "done",
  // A canceled issue is finished work that will not ship. tasks-axi has no
  // canceled state, and treating it as anything but done would leave it
  // forever in the dispatch queue.
  canceled: "done",
};

/** The state type a transition targets, addressed by type so renames are safe. */
export const TYPE_FOR_STATE: Record<State, string> = {
  queued: "unstarted",
  in_flight: "started",
  done: "completed",
};

export function stateForType(type: string): State {
  // An unknown type is an open state Linear added after this code shipped;
  // queued is the safe default because it keeps the work visible.
  return STATE_BY_TYPE[type] ?? "queued";
}

/** The `repo/<name>` label convention that carries `repo` into Linear. */
export const REPO_LABEL_PREFIX = "repo/";
/** Every issue this backend owns carries the fleet label. */
export const FM_LABEL = "fm";
/**
 * The label a held issue carries, so a hold is filterable server-side in
 * Linear's own UI (`label:hold/captain`) without reading any description.
 *
 * A hold kind is optional in the model, so an untyped hold carries the bare
 * `hold` label and a typed one carries `hold/<kind>`; no kind is ever invented.
 * The label is derived state: `fm-meta` remains the authoritative record of the
 * reason and the `until` date, because Linear has no column for either.
 */
export const HOLD_LABEL = "hold";
export const HOLD_LABEL_PREFIX = "hold/";

export function repoLabel(repo: string): string {
  return `${REPO_LABEL_PREFIX}${repo}`;
}

/** The label name for a hold, or undefined when the task is not held. */
export function holdLabel(hold: Hold | undefined): string | undefined {
  if (!hold) return undefined;
  return hold.kind ? `${HOLD_LABEL_PREFIX}${hold.kind}` : HOLD_LABEL;
}

export function isHoldLabel(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === HOLD_LABEL || lower.startsWith(HOLD_LABEL_PREFIX);
}

function repoFromLabels(labels: string[]): string | undefined {
  const found = labels.find((name) =>
    name.toLowerCase().startsWith(REPO_LABEL_PREFIX),
  );
  return found ? found.slice(REPO_LABEL_PREFIX.length) : undefined;
}

/**
 * Linear's priority scale runs 0 = "No priority", 1 = Urgent .. 4 = Low, while
 * tasks-axi's runs 0..4 with higher meaning more urgent. Mapping is therefore
 * an inversion, not a copy, and Linear's 0 means "unset" rather than "lowest".
 *
 * Linear rejects any value above 4, so tasks-axi 0 and 1 both fold onto Linear
 * 4 (Low): a writable lowest priority matters more than an injective mapping,
 * and every other value still round-trips.
 */
export function priorityToLinear(priority: number | undefined): number {
  if (priority === undefined) return 0;
  return 5 - Math.max(1, Math.min(4, priority));
}

export function priorityFromLinear(priority: number): number | undefined {
  if (priority <= 0 || priority > 4) return undefined;
  return 5 - priority;
}

/** The shape of a Linear issue this backend reads; a subset of the client type. */
export interface LinearIssueNode {
  /** Linear's UUID. Batch mutations address issues by UUID, not identifier. */
  id?: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
  state: { name: string; type: string };
  labels: { nodes: { id?: string; name: string }[] };
  project?: { name: string } | null;
  /** Edges pointing at this issue: a `blocks` inverse edge means "blocked by". */
  inverseRelations: {
    nodes: { type: string; issue?: { identifier: string } | null }[];
  };
}

/** The identifier-to-slug table needed to express a blocking edge as task ids. */
export type SlugTable = Map<string, string>;

/**
 * Build the identifier -> slug table for a snapshot. Blocking edges arrive as
 * Linear identifiers (`DEV-44`), but the task model addresses dependencies by
 * tasks-axi id, so the whole snapshot has to be indexed before any single
 * issue can be converted.
 */
export function slugTable(issues: LinearIssueNode[]): SlugTable {
  const table: SlugTable = new Map();
  for (const issue of issues) {
    const { meta } = parseDescription(issue.description);
    table.set(issue.identifier, meta.slug ?? issue.identifier);
  }
  return table;
}

export function toTask(issue: LinearIssueNode, slugs: SlugTable): Task {
  const { meta, body } = parseDescription(issue.description);
  const id = meta.slug ?? issue.identifier;
  const labels = issue.labels.nodes.map((node) => node.name);
  const state = stateForType(issue.state.type);

  // PR links are derived from the prose exactly as in the markdown backend, so
  // a PR url pasted into a Linear title behaves identically in both backends.
  const links: TaskLink[] = deriveLinks(issue.title).filter(
    (link) => link.kind === "pr",
  );
  for (const link of meta.links ?? []) {
    if (!links.some((existing) => existing.url === link.url)) links.push(link);
  }

  const task: Task = {
    id,
    title: issue.title,
    state,
    links,
    deps: issue.inverseRelations.nodes
      .filter((relation) => relation.type === "blocks" && relation.issue)
      .map((relation) => {
        const blockerId = relation.issue?.identifier as string;
        const slug = slugs.get(blockerId) ?? blockerId;
        const reason = meta.depReasons?.[slug];
        return {
          type: "blocked-by" as const,
          id: slug,
          ...(reason ? { reason } : {}),
        };
      }),
    meta: {
      linear_id: issue.identifier,
      ...(issue.id ? { linear_uuid: issue.id } : {}),
      linear_url: issue.url,
      linear_state: issue.state.name,
      linear_state_type: issue.state.type,
    },
  };

  // Kind resolution mirrors the markdown backend exactly: an explicit tag
  // wins, and otherwise a leading `SHIP`/`SCOUT`/`DOCS-ONLY` word in the prose
  // carries it, so the same title yields the same kind in either backend.
  const kind = meta.kind ?? leadingKind(issue.title);
  if (kind) task.kind = kind;
  const repo = repoFromLabels(labels);
  if (repo) task.repo = repo;
  if (body !== undefined) task.body = body;
  if (meta.hold) task.hold = meta.hold;
  if (meta.resume) task.resume = meta.resume;
  if (meta.publicFollowup) task.public_followup = meta.publicFollowup;

  const priority = priorityFromLinear(issue.priority);
  if (priority !== undefined) task.priority = priority;

  const created = meta.created ?? issue.createdAt.slice(0, 10);
  if (state !== "done") task.created = created;
  task.updated = issue.updatedAt.slice(0, 10);
  if (state === "done") task.closed = issue.updatedAt.slice(0, 10);

  return task;
}
