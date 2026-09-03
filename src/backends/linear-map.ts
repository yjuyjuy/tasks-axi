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
 * Holds are expressed as a Linear **label group**, not as flat `hold/<kind>`
 * names.
 *
 * This is Linear's own convention for exactly this shape, and the DEV team was
 * already using it - a `Hold` group with `External`, `Parked`, `Future`
 * children - before tasks-axi wrote anything. Two things follow. A flat label
 * named `hold` is *rejected* by the API when a `Hold` group exists ("is a group
 * and cannot be assigned to issues directly"), and a group is mutually
 * exclusive in Linear's UI, so an issue can never carry two hold kinds at once.
 * Reusing the group therefore fixes a real failure and makes a hold filterable
 * with the team's existing saved views.
 *
 * `fm-meta` stays the authoritative record of the reason and the `until` date,
 * which Linear has no column for; the label is the filterable projection.
 */
export const HOLD_GROUP = "Hold";
/** A hold with no kind still has to be filterable, so it gets its own child. */
export const HOLD_UNSPECIFIED = "Unspecified";
/** Legacy flat names an earlier build could have written; recognized so they are cleaned up. */
const LEGACY_HOLD_PREFIX = "hold";

/** A hold label is `<Hold group>/<Kind>`; the child name carries the kind. */
export interface HoldLabelRef {
  group: string;
  name: string;
}

export function repoLabel(repo: string): string {
  return `${REPO_LABEL_PREFIX}${repo}`;
}

/**
 * The group child a hold should map to, or undefined when the task is not held.
 * The child name is title-cased to match the sibling labels a human created.
 */
export function holdLabel(hold: Hold | undefined): HoldLabelRef | undefined {
  if (!hold) return undefined;
  const kind = hold.kind ?? HOLD_UNSPECIFIED;
  return {
    group: HOLD_GROUP,
    name: kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase(),
  };
}

/**
 * True for a label this backend manages as a hold: any child of the `Hold`
 * group, plus the flat `hold` / `hold/<kind>` names an earlier build wrote, so
 * a stale one is cleaned up on the next hold write rather than lingering.
 */
export function isHoldLabel(name: string, parent?: string): boolean {
  if (parent && parent.toLowerCase() === HOLD_GROUP.toLowerCase()) return true;
  const lower = name.toLowerCase();
  return lower === LEGACY_HOLD_PREFIX || lower.startsWith(`${LEGACY_HOLD_PREFIX}/`);
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
