import { rmSync } from "node:fs";
import { AxiError, crossBackendMove, unsupported } from "../errors.js";
import { validateDependencyId, validateId } from "../id.js";
import type {
  Dep,
  State,
  Task,
  TaskInput,
  TaskPatch,
  TaskQuery,
  TaskUpdateChange,
  TaskUpdateResult,
  TransitionOpts,
} from "../model.js";
import {
  PUBLIC_FOLLOWUP_KIND,
  assertPublicFollowupMutation,
  assertPublicFollowupTaskState,
  canonicalEqual,
  isPublicFollowupTask,
  isPublicFollowupTerminal,
  normalizePublicFollowup,
  type PublicFollowupMutation,
} from "../public-followup.js";
import type {
  Capabilities,
  PruneOptions,
  PruneResult,
  Store,
} from "../store.js";
import type { LinearClientLike } from "./linear-client.js";
import { loadClientModule } from "./linear-client.js";
import {
  isFresh,
  newestUpdatedAt,
  readSnapshot,
  writeSnapshot,
  CACHE_VERSION,
  type Snapshot,
} from "./linear-cache.js";
import {
  FM_LABEL,
  REPO_LABEL_PREFIX,
  TYPE_FOR_STATE,
  holdLabel,
  isHoldLabel,
  priorityToLinear,
  repoLabel,
  slugTable,
  toTask,
  type LinearIssueNode,
} from "./linear-map.js";
import { renderDescription } from "./linear-meta.js";
import { readMirrorTasks, renderMirror } from "./linear-mirror.js";
import {
  BLOCKERS_QUERY,
  ISSUE_ARCHIVE_MUTATION,
  ISSUE_BATCH_UPDATE_MUTATION,
  ISSUE_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
  LABEL_CREATE_MUTATION,
  RELATION_CREATE_MUTATION,
  RELATION_DELETE_MUTATION,
  RESOLVE_QUERY,
  SNAPSHOT_PAGE_QUERY,
  SNAPSHOT_QUERY,
} from "./linear-queries.js";
import { deriveLinks } from "./markdown-grammar.js";

/**
 * The `linear` backend: a firstmate home whose backlog lives in a Linear
 * project rather than a markdown file.
 *
 * Three design points carry most of the weight.
 *
 * 1. **State is read and written by type, never by name.** See `linear-map.ts`.
 * 2. **Every read goes through one batched snapshot of the whole partition,**
 *    cached on disk. A command that reads several tasks - which is most of
 *    them, because `blocked`/`ready` are derived from the full graph - costs
 *    one network request, and a second command inside the TTL costs none.
 * 3. **Read paths degrade offline, write paths fail loud.** Every successful
 *    sync rewrites a read-only markdown mirror, so with the network blocked a
 *    read still answers from the mirror while a mutation raises a structured
 *    error instead of silently diverging from the tracker.
 *
 * Ids: the caller-supplied slug remains the join key (decision D6) and rides in
 * the `fm-meta` block; Linear's own `DEV-44` identifier is carried in
 * `task.meta.linear_id` and is what every mutation addresses.
 */

export interface LinearStoreOptions {
  team: string;
  project: string;
  /** Seconds a cached snapshot is served without any network request. */
  cacheTtl: number;
  /** Where the read-only markdown mirror is rendered. */
  mirrorPath: string;
  /** Where the snapshot cache is stored (default `<mirror>.cache.json`). */
  cachePath?: string;
  /** Injected client, for tests; otherwise `linear-axi/client` is loaded. */
  client?: LinearClientLike;
  env?: NodeJS.ProcessEnv;
  /** Injectable clock returning epoch millis (for tests). */
  nowMs?: () => number;
  /** Injectable clock returning a YYYY-MM-DD stamp (for tests). */
  now?: () => string;
}

/** Linear caps every connection at 250. */
const PAGE = 250;
/** Enough pages for a backlog far larger than any home; a guard, not a limit. */
const MAX_PAGES = 20;

interface ResolveTables {
  teamId: string;
  projectId: string;
  states: { id: string; name: string; type: string; position: number }[];
  labels: {
    id: string;
    name: string;
    isGroup?: boolean;
    parent?: { name: string } | null;
  }[];
}

function today(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export class LinearStore implements Store {
  private readonly team: string;
  private readonly project: string;
  private readonly cacheTtl: number;
  private readonly mirrorPath: string;
  private readonly cachePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nowMs: () => number;
  private readonly now: () => string;
  private injectedClient: LinearClientLike | undefined;
  private clientPromise: Promise<LinearClientLike> | undefined;
  private tables: ResolveTables | undefined;
  /** The snapshot this process is working from; one fetch per process, at most. */
  private snapshot: Snapshot | undefined;
  /**
   * Set by every mutation: the next read must go to Linear even though the
   * on-disk cache is still inside its TTL, because we just changed the data
   * that cache describes and would otherwise read our own write back as absent.
   */
  private mustRefetch = false;

  constructor(options: LinearStoreOptions) {
    this.team = options.team;
    this.project = options.project;
    this.cacheTtl = options.cacheTtl;
    this.mirrorPath = options.mirrorPath;
    this.cachePath = options.cachePath ?? `${options.mirrorPath}.cache.json`;
    this.env = options.env ?? process.env;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.now = options.now ?? today;
    this.injectedClient = options.client;
  }

  capabilities(): Capabilities {
    return {
      backend: "linear",
      deps: true,
      prune: true,
      comments: false,
      fullTextSearch: false,
      realtimeSync: false,
      customStates: true,
      // Linear mints `DEV-44`, but the tasks-axi id stays caller-supplied and
      // travels in `fm-meta`, so the CLI's id handling is unchanged.
      serverMintsIds: false,
      publicFollowups: true,
      crossHomeMove: true,
    };
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async client(): Promise<LinearClientLike> {
    if (this.injectedClient) return this.injectedClient;
    this.clientPromise ??= loadClientModule().then((module) =>
      module.createClient({ env: this.env }),
    );
    return this.clientPromise;
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
    operation: string,
  ): Promise<T> {
    const client = await this.client();
    return client.request<T>(query, variables, operation);
  }

  /** The `IssueFilter` that isolates this home's partition. */
  private partitionFilter(): Record<string, unknown> {
    return {
      and: [
        { team: { key: { eq: this.team } } },
        { project: { name: { eqIgnoreCase: this.project } } },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Snapshot + cache + mirror
  // -------------------------------------------------------------------------

  /**
   * Every read verb's entry point: the partition as tasks, from the freshest
   * source available. Online (or inside the TTL) that is the snapshot; with
   * the network down and no usable snapshot it is the markdown mirror, which
   * is why `list` keeps working offline.
   */
  private async tasks(): Promise<Task[]> {
    const snapshot = await this.load();
    return snapshot ? this.tasksFrom(snapshot) : readMirrorTasks(this.mirrorPath);
  }

  /**
   * The whole partition, from cache when fresh and from Linear otherwise.
   *
   * Every read verb funnels through here, which is what bounds a command to a
   * single request no matter how many tasks it touches. Returns undefined only
   * when Linear is unreachable and no snapshot survives, leaving the mirror as
   * the last resort.
   */
  private async load(): Promise<Snapshot | undefined> {
    if (this.snapshot) return this.snapshot;

    const cached = readSnapshot(this.cachePath);
    if (
      !this.mustRefetch &&
      cached &&
      isFresh(cached, this.cacheTtl, this.nowMs(), this.team, this.project)
    ) {
      this.snapshot = cached;
      return cached;
    }

    try {
      this.snapshot = await this.fetchSnapshot();
      return this.snapshot;
    } catch (error) {
      // Reads degrade gracefully: a stale snapshot is far more useful than a
      // failure, and the mirror on disk is the fallback when even that is
      // absent. A mutation never reaches this path - it calls `requireOnline`.
      if (isOffline(error)) {
        if (cached) {
          this.snapshot = cached;
          return cached;
        }
        return undefined;
      }
      throw error;
    }
  }

  private async fetchSnapshot(): Promise<Snapshot> {
    const issues = await this.fetchIssues();
    this.mustRefetch = false;
    const snapshot: Snapshot = {
      version: CACHE_VERSION,
      fetchedAt: this.nowMs(),
      team: this.team,
      project: this.project,
      updatedAt: newestUpdatedAt(issues),
      issues,
    };
    writeSnapshot(this.cachePath, snapshot);
    // The mirror is rendered on every successful sync, so the offline read
    // path is always as current as the last time anything talked to Linear.
    this.writeMirror(snapshot);
    return snapshot;
  }

  private async fetchIssues(): Promise<LinearIssueNode[]> {
    const filter = this.partitionFilter();
    const nodes: LinearIssueNode[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.request<{
        issues: {
          nodes: LinearIssueNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(
        after ? SNAPSHOT_PAGE_QUERY : SNAPSHOT_QUERY,
        { first: PAGE, filter, ...(after ? { after } : {}) },
        "sync",
      );
      nodes.push(...data.issues.nodes);
      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor ?? undefined;
      if (!after) break;
    }
    return nodes;
  }

  private writeMirror(snapshot: Snapshot): void {
    try {
      renderMirror(this.mirrorPath, this.tasksFrom(snapshot), {
        team: this.team,
        project: this.project,
        syncedAt: new Date(snapshot.fetchedAt).toISOString(),
      });
    } catch {
      // The mirror is a convenience for offline reads and other tools; failing
      // to write it must never fail the command that just synced successfully.
    }
  }

  private tasksFrom(snapshot: Snapshot): Task[] {
    const slugs = slugTable(snapshot.issues);
    return snapshot.issues.map((issue) => toTask(issue, slugs));
  }

  /**
   * Drop the cached snapshot so the next read reflects a write we just made -
   * in this process *and* in the next one.
   *
   * Dropping only the in-memory copy is not enough. Most commands read back
   * after writing, which refreshes the on-disk cache as a side effect, but a
   * command that does not (`mv` moves a set and reports, without re-reading)
   * would leave a pre-write snapshot on disk for the whole TTL, and the next
   * process would serve it and show the write as not having happened. Caught
   * live: after a successful cross-home move, both homes still listed the old
   * contents. Deleting the file is safe because it is derived data, and the
   * offline read path falls back to the markdown mirror.
   */
  private invalidate(): void {
    this.snapshot = undefined;
    this.mustRefetch = true;
    try {
      rmSync(this.cachePath, { force: true });
    } catch {
      // A cache we cannot delete is a cache the next read revalidates anyway.
    }
  }

  /**
   * Every mutation calls this first: with the network down a write must fail
   * loudly rather than pretend, because there is no local store to write to.
   */
  private async requireOnline(action: string): Promise<Snapshot> {
    try {
      // Reuse the freshly fetched snapshot for this command's reads: the write
      // path still calls `invalidate()` afterwards, so the NEXT read refetches.
      this.snapshot = await this.fetchSnapshot();
      return this.snapshot;
    } catch (error) {
      if (isOffline(error)) {
        throw new AxiError(
          `Cannot ${action}: the linear backend is offline and mutations require Linear`,
          "UNSUPPORTED",
          [
            "Restore network access and retry; reads still work from the local mirror",
            `Mirror: ${this.mirrorPath}`,
          ],
        );
      }
      throw error;
    }
  }

  private async resolveTables(): Promise<ResolveTables> {
    if (this.tables) return this.tables;
    const data = await this.request<{
      team: {
        id: string;
        key: string;
        states: { nodes: ResolveTables["states"] };
        labels: { nodes: ResolveTables["labels"] };
        projects: { nodes: { id: string; name: string }[] };
      } | null;
    }>(
      RESOLVE_QUERY,
      { teamKey: this.team, project: this.project, first: PAGE },
      "resolve",
    );
    if (!data.team) {
      throw new AxiError(`No Linear team "${this.team}"`, "NOT_FOUND", [
        "Run `linear-axi teams` to see the team keys",
      ]);
    }
    const project = data.team.projects.nodes[0];
    if (!project) {
      throw new AxiError(
        `No Linear project "${this.project}" in team ${this.team}`,
        "NOT_FOUND",
        [`Run \`linear-axi projects --team ${this.team}\` to see the projects`],
      );
    }
    this.tables = {
      teamId: data.team.id,
      projectId: project.id,
      states: data.team.states.nodes,
      labels: data.team.labels.nodes,
    };
    return this.tables;
  }

  /**
   * The workflow state id for a tasks-axi state, chosen by TYPE. When a team
   * has several states of one type (`In Progress`, `PR Ready`, `Testing` are
   * all `started`), the lowest-positioned one is the canonical entry point.
   */
  private stateId(tables: ResolveTables, state: State): string {
    const type = TYPE_FOR_STATE[state];
    const candidates = tables.states
      .filter((node) => node.type === type)
      .sort((a, b) => a.position - b.position);
    const chosen = candidates[0];
    if (!chosen) {
      throw new AxiError(
        `Team ${this.team} has no workflow state of type "${type}"`,
        "VALIDATION_ERROR",
        [`Add a "${type}" state to the team in Linear`],
      );
    }
    return chosen.id;
  }

  /**
   * The full label set an issue should carry, as ids.
   *
   * Linear's `labelIds` is a replacement, not a merge, so this reconciles
   * rather than overwrites: every label tasks-axi does not manage is carried
   * through untouched (a human's `Feature` or `AFK` label must survive a
   * `hold`), and the three managed families - `fm`, `repo/<name>`, and
   * `hold[/<kind>]` - are rewritten from the task. Dropping a managed label is
   * how `unhold` removes `hold/captain`.
   */
  private async labelIdsFor(
    tables: ResolveTables,
    task: { repo?: string; hold?: Task["hold"] },
    existing: string[] = [],
  ): Promise<string[]> {
    const parentOf = (name: string): string | undefined =>
      tables.labels.find(
        (label) => label.name.toLowerCase() === name.toLowerCase(),
      )?.parent?.name;
    const managed = (name: string): boolean =>
      name.toLowerCase() === FM_LABEL ||
      name.toLowerCase().startsWith(REPO_LABEL_PREFIX) ||
      isHoldLabel(name, parentOf(name));
    const hold = holdLabel(task.hold);
    const ids = await this.ensureLabelIds(tables, [
      ...existing.filter((name) => !managed(name)),
      FM_LABEL,
      ...(task.repo ? [repoLabel(task.repo)] : []),
    ]);
    if (hold) ids.push(await this.holdLabelId(tables, hold));
    return [...new Set(ids)];
  }

  /**
   * The id of the `Hold` group child for a hold kind, creating the group and
   * the child if the team does not have them yet. Nesting under the group is
   * what makes the label assignable at all - Linear rejects a flat label whose
   * name collides with a group - and makes hold kinds mutually exclusive.
   */
  private async holdLabelId(
    tables: ResolveTables,
    hold: { group: string; name: string },
  ): Promise<string> {
    const group = tables.labels.find(
      (label) =>
        label.name.toLowerCase() === hold.group.toLowerCase() && label.isGroup,
    );
    const groupId =
      group?.id ??
      (await this.createLabel(tables, hold.group, undefined, true)).id;
    const existing = tables.labels.find(
      (label) =>
        label.name.toLowerCase() === hold.name.toLowerCase() &&
        label.parent?.name.toLowerCase() === hold.group.toLowerCase(),
    );
    if (existing) return existing.id;
    return (await this.createLabel(tables, hold.name, groupId, false)).id;
  }

  private async createLabel(
    tables: ResolveTables,
    name: string,
    parentId: string | undefined,
    isGroup: boolean,
  ): Promise<{ id: string; name: string }> {
    const created = await this.request<{
      issueLabelCreate: {
        success: boolean;
        issueLabel: { id: string; name: string; parent?: { name: string } | null };
      };
    }>(
      LABEL_CREATE_MUTATION,
      {
        input: {
          name,
          // A child inherits its parent's scope. The `Hold` group is a
          // workspace label here, and Linear refuses "a label to a group from a
          // different team", so a nested label must NOT carry a teamId - only a
          // top-level label this backend mints itself is team-scoped.
          ...(parentId ? { parentId } : { teamId: tables.teamId }),
        },
      },
      "label",
    );
    const label = created.issueLabelCreate.issueLabel;
    tables.labels.push({
      ...label,
      isGroup,
      parent: label.parent ?? null,
    });
    return label;
  }

  /**
   * Resolve label names to ids, creating a missing label rather than failing:
   * a `repo/<name>` or `hold/<kind>` label is derived from the task, not
   * chosen from a menu, so a new repo or hold kind must not need a human to
   * pre-create its label in Linear.
   */
  private async ensureLabelIds(
    tables: ResolveTables,
    names: string[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const name of [...new Set(names)]) {
      const existing = tables.labels.find(
        (label) => label.name.toLowerCase() === name.toLowerCase(),
      );
      if (existing) {
        if (!ids.includes(existing.id)) ids.push(existing.id);
        continue;
      }
      const label = await this.createLabel(tables, name, undefined, false);
      if (!ids.includes(label.id)) ids.push(label.id);
    }
    return ids;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async get(id: string): Promise<Task | null> {
    const tasks = await this.tasks();
    return tasks.find((task) => task.id === id) ?? null;
  }

  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    let items = await this.tasks();
    if (query.state) items = items.filter((t) => t.state === query.state);
    if (query.repo) items = items.filter((t) => t.repo === query.repo);
    if (query.kind) items = items.filter((t) => t.kind === query.kind);
    const total = items.length;
    if (query.limit !== undefined && query.limit >= 0) {
      items = items.slice(0, query.limit);
    }
    return { items, total };
  }

  /** The Linear identifier a mutation addresses, from the current snapshot. */
  private async requireIssueKey(id: string): Promise<{ key: string; task: Task }> {
    const task = await this.get(id);
    if (!task) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    const key = task.meta?.linear_id;
    if (typeof key !== "string") {
      throw new AxiError(
        `Task "${id}" has no Linear identifier`,
        "UNKNOWN",
      );
    }
    return { key, task };
  }

  /**
   * The labels an issue currently carries, by name. A mutation runs after
   * `requireOnline`, so this reads the snapshot that call just fetched and
   * costs no extra request.
   */
  private async currentLabelNames(key: string): Promise<string[]> {
    const snapshot = await this.load();
    const issue = snapshot?.issues.find((node) => node.identifier === key);
    return issue?.labels.nodes.map((node) => node.name) ?? [];
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async create(input: TaskInput): Promise<Task> {
    const id = validateId(input.id);
    await this.requireOnline(`create "${id}"`);
    if (await this.get(id)) {
      throw new AxiError(`Task "${id}" already exists`, "CONFLICT");
    }

    const state: State = input.state ?? "queued";
    let title = input.title.trim();
    for (const link of input.links ?? []) {
      if (link.kind === "pr" && !title.includes(link.url)) {
        title = `${title} ${link.url}`;
      }
    }
    const deps = (input.deps ?? []).map((dep) => ({
      ...dep,
      id: validateDependencyId(dep.id),
    }));
    // Blockers are resolved before the create so a bad edge fails before any
    // issue exists, matching the markdown backend's ordering.
    const blockerKeys = await this.resolveBlockerKeys(deps);

    const draft: Task = {
      id,
      title,
      state,
      links: deriveLinks(title),
      deps,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.body ? { body: input.body } : {}),
      ...(input.hold ? { hold: input.hold } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.public_followup
        ? { public_followup: normalizePublicFollowup(input.public_followup) }
        : {}),
      created:
        input.created === null
          ? undefined
          : (input.created ?? this.now()),
    };
    for (const link of input.links ?? []) {
      if (link.kind !== "pr" && !draft.links.some((l) => l.url === link.url)) {
        draft.links.push(link);
      }
    }

    const tables = await this.resolveTables();
    const created = await this.request<{
      issueCreate: { success: boolean; issue: LinearIssueNode };
    }>(
      ISSUE_CREATE_MUTATION,
      {
        input: {
          teamId: tables.teamId,
          projectId: tables.projectId,
          title: draft.title,
          description: renderDescription(draft),
          stateId: this.stateId(tables, state),
          priority: priorityToLinear(draft.priority),
          labelIds: await this.labelIdsFor(tables, draft),
        },
      },
      "create",
    );
    const issue = created.issueCreate.issue;

    for (const key of blockerKeys) {
      await this.createRelation(issue.identifier, key);
    }

    this.invalidate();
    const task = await this.get(id);
    if (!task) {
      throw new AxiError(
        `Created "${id}" but it is not visible in the project yet`,
        "UNKNOWN",
        ["Re-run the command; Linear may not have indexed the issue yet"],
      );
    }
    return task;
  }

  private async resolveBlockerKeys(deps: Dep[]): Promise<string[]> {
    const keys: string[] = [];
    for (const dep of deps) {
      if (dep.type !== "blocked-by") continue;
      const blocker = await this.get(dep.id);
      if (!blocker) {
        throw new AxiError(`blocker "${dep.id}" not found`, "VALIDATION_ERROR", [
          "Create the dependency task first, or choose an existing task id",
        ]);
      }
      keys.push(blocker.meta?.linear_id as string);
    }
    return keys;
  }

  /** `by` blocks `key`; the relation is owned by the blocker. */
  private async createRelation(key: string, by: string): Promise<void> {
    await this.request(
      RELATION_CREATE_MUTATION,
      { input: { type: "blocks", issueId: by, relatedIssueId: key } },
      "block",
    );
  }

  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    await this.requireOnline(`update "${id}"`);
    if (patch.archiveBody) {
      // There is no note archive on this backend, so honouring the flag would
      // silently destroy the superseded body instead of preserving it.
      throw unsupported("--archive-body", this.capabilities().backend);
    }
    const { key, task } = await this.requireIssueKey(id);

    if (
      isPublicFollowupTask(task) &&
      (patch.title !== undefined ||
        patch.body !== undefined ||
        patch.archiveBody ||
        (patch.addBodyLines?.length ?? 0) > 0 ||
        (patch.addLinks?.length ?? 0) > 0 ||
        patch.hold !== undefined)
    ) {
      throw new AxiError(
        "Public-followup content and holds cannot change through generic update",
        "VALIDATION_ERROR",
        ["Create a successor obligation when the public promise changes"],
      );
    }

    const next: Task = {
      ...task,
      deps: task.deps.map((dep) => ({ ...dep })),
      links: task.links.map((link) => ({ ...link })),
    };
    const changed: TaskUpdateChange[] = [];
    const mark = (field: TaskUpdateChange) => {
      if (!changed.includes(field)) changed.push(field);
    };

    if (patch.title !== undefined && patch.title.trim() !== task.title) {
      next.title = patch.title.trim();
      mark("title");
    }
    if (patch.body !== undefined) {
      const body = patch.body || undefined;
      if (body !== task.body) {
        next.body = body;
        mark("body");
      }
    }
    for (const line of patch.addBodyLines ?? []) {
      if (line !== "" && !(next.body ?? "").split("\n").includes(line)) {
        next.body = next.body ? `${next.body}\n${line}` : line;
        mark("body");
      }
    }
    if (patch.repo !== undefined && patch.repo !== task.repo) {
      next.repo = patch.repo;
      mark("repo");
    }
    if (patch.kind !== undefined) {
      if (task.kind === PUBLIC_FOLLOWUP_KIND || patch.kind === PUBLIC_FOLLOWUP_KIND) {
        throw new AxiError(
          "Public-followup kind cannot be changed through generic update",
          "VALIDATION_ERROR",
          ["Use the dedicated `tasks-axi public-followup` commands"],
        );
      }
      if (patch.kind !== task.kind) {
        next.kind = patch.kind;
        mark("kind");
      }
    }
    if (patch.hold !== undefined) {
      const hold = patch.hold ?? undefined;
      if (JSON.stringify(hold ?? null) !== JSON.stringify(task.hold ?? null)) {
        next.hold = hold;
        mark("hold");
      }
    }
    if (patch.priority !== undefined && patch.priority !== task.priority) {
      next.priority = patch.priority;
      mark("priority");
    }
    if (patch.resume !== undefined) {
      const resume = patch.resume ?? undefined;
      if (resume !== task.resume) {
        next.resume = resume;
        mark("resume");
      }
    }
    for (const link of patch.addLinks ?? []) {
      if (link.kind === "pr") {
        if (!next.title.includes(link.url)) {
          next.title = `${next.title} ${link.url}`;
          mark("links");
        }
      } else if (!next.links.some((existing) => existing.url === link.url)) {
        next.links.push(link);
        mark("links");
      }
    }
    if (patch.meta) {
      next.meta = { ...next.meta, ...patch.meta };
      mark("meta");
    }

    if (changed.length === 0) return { task, changed };
    next.links = [
      ...deriveLinks(next.title).filter((link) => link.kind === "pr"),
      ...next.links.filter((link) => link.kind !== "pr"),
    ];

    const tables = await this.resolveTables();
    const input: Record<string, unknown> = {
      title: next.title,
      description: renderDescription(next),
    };
    if (changed.includes("priority")) {
      input.priority = priorityToLinear(next.priority);
    }
    if (changed.includes("repo") || changed.includes("hold")) {
      // A hold is filterable server-side because it is also a label; the
      // reconciliation keeps every label tasks-axi does not manage.
      input.labelIds = await this.labelIdsFor(
        tables,
        next,
        await this.currentLabelNames(key),
      );
    }
    await this.request(ISSUE_UPDATE_MUTATION, { id: key, input }, "update");

    this.invalidate();
    const updated = (await this.get(id)) ?? next;
    return { task: updated, changed };
  }

  async remove(id: string): Promise<Task> {
    await this.requireOnline(`remove "${id}"`);
    const { key, task } = await this.requireIssueKey(id);
    if (
      isPublicFollowupTask(task) &&
      task.public_followup &&
      !isPublicFollowupTerminal(task.public_followup)
    ) {
      throw new AxiError(
        "Active public-followup obligations cannot be removed",
        "VALIDATION_ERROR",
        ["Record a posted receipt or Captain-approved waiver first"],
      );
    }
    const dependents = (await this.list({})).items
      .filter(
        (candidate) =>
          candidate.state !== "done" &&
          candidate.deps.some(
            (dep) => dep.type === "blocked-by" && dep.id === id,
          ),
      )
      .map((candidate) => candidate.id);
    if (dependents.length > 0) {
      throw new AxiError(
        `Task "${id}" is still blocking active tasks: ${dependents.join(", ")}`,
        "VALIDATION_ERROR",
        [
          `Unblock them first, e.g. \`tasks-axi unblock ${dependents[0]} --by ${id}\``,
        ],
      );
    }
    // Linear has no delete verb by design; archiving removes the issue from
    // every view and from this backend's snapshot, and stays recoverable.
    await this.request(ISSUE_ARCHIVE_MUTATION, { id: key }, "rm");
    this.invalidate();
    return task;
  }

  async transition(
    id: string,
    to: State,
    opts: TransitionOpts = {},
  ): Promise<Task> {
    await this.requireOnline(`transition "${id}"`);
    const { key, task } = await this.requireIssueKey(id);
    if (isPublicFollowupTask(task)) {
      throw new AxiError(
        "Public-followup state cannot change through generic transitions",
        "VALIDATION_ERROR",
        [
          "Use `tasks-axi public-followup record-delivery` or `tasks-axi public-followup waive`",
        ],
      );
    }

    const next: Task = {
      ...task,
      deps: task.deps.map((dep) => ({ ...dep })),
      links: task.links.map((link) => ({ ...link })),
      state: to,
    };
    if (opts.pr && !next.title.includes(opts.pr)) {
      next.title = `${next.title} ${opts.pr}`;
    }
    if (opts.report && !next.links.some((link) => link.url === opts.report)) {
      next.links.push({ kind: "report", url: opts.report });
    }
    if (opts.note) {
      next.body = next.body ? `${next.body}\n${opts.note}` : opts.note;
    }
    if (to === "in_flight" && !next.created) next.created = this.now();

    const tables = await this.resolveTables();
    await this.request(
      ISSUE_UPDATE_MUTATION,
      {
        id: key,
        input: {
          title: next.title,
          description: renderDescription(next),
          stateId: this.stateId(tables, to),
        },
      },
      "transition",
    );
    this.invalidate();
    return (await this.get(id)) ?? next;
  }

  async addDep(id: string, dep: Dep): Promise<boolean> {
    if (dep.id === id) {
      throw new AxiError("A task cannot block itself", "VALIDATION_ERROR");
    }
    await this.requireOnline(`block "${id}"`);
    const { key, task } = await this.requireIssueKey(id);
    if (
      task.public_followup &&
      !["intent", "pending-work", "ready"].includes(
        task.public_followup.delivery.state,
      )
    ) {
      throw new AxiError(
        "Cannot add blockers after public delivery has started",
        "VALIDATION_ERROR",
      );
    }
    if (task.deps.some((d) => d.type === dep.type && d.id === dep.id)) {
      return false;
    }
    if (dep.type !== "blocked-by") {
      // Linear models only blocking relations; anything else would post a
      // relation with no issue id and report a success that never happened.
      throw unsupported(`"${dep.type}" dependencies`, this.capabilities().backend);
    }
    const [blockerKey] = await this.resolveBlockerKeys([dep]);
    await this.createRelation(key, blockerKey);
    if (dep.reason) {
      // The reason has no Linear column, so it lives in the blocked issue's
      // `fm-meta` block and needs a second write.
      await this.writeDepReason(key, task, dep);
    }
    this.invalidate();
    return true;
  }

  private async writeDepReason(
    key: string,
    task: Task,
    dep: Dep,
  ): Promise<void> {
    const next: Task = {
      ...task,
      deps: [...task.deps.map((d) => ({ ...d })), { ...dep }],
    };
    await this.request(
      ISSUE_UPDATE_MUTATION,
      { id: key, input: { description: renderDescription(next) } },
      "block",
    );
  }

  async removeDep(id: string, dep: Dep): Promise<boolean> {
    await this.requireOnline(`unblock "${id}"`);
    const { key, task } = await this.requireIssueKey(id);
    if (!task.deps.some((d) => d.type === dep.type && d.id === dep.id)) {
      return false;
    }
    const blocker = await this.get(dep.id);
    const blockerKey = blocker?.meta?.linear_id as string | undefined;
    if (!blockerKey) return false;

    const found = await this.request<{
      issue: {
        inverseRelations: {
          nodes: { id: string; type: string; issue: { identifier: string } }[];
        };
      } | null;
    }>(BLOCKERS_QUERY, { id: key, first: PAGE }, "unblock");
    const edge = found.issue?.inverseRelations.nodes.find(
      (relation) =>
        relation.type === "blocks" &&
        relation.issue.identifier.toUpperCase() === blockerKey.toUpperCase(),
    );
    if (!edge) return false;
    // `issueRelationDelete` takes the relation's own id, not the issue pair.
    await this.request(RELATION_DELETE_MUTATION, { id: edge.id }, "unblock");
    this.invalidate();
    return true;
  }

  async updatePublicFollowup(
    id: string,
    mutation: PublicFollowupMutation,
  ): Promise<Task> {
    await this.requireOnline(`update public-followup "${id}"`);
    const { key, task } = await this.requireIssueKey(id);
    if (!isPublicFollowupTask(task) || !task.public_followup) {
      throw new AxiError(
        `Task "${id}" is not a public-followup obligation`,
        "VALIDATION_ERROR",
      );
    }
    const expected = normalizePublicFollowup(mutation.expectedPublicFollowup);
    if (
      task.public_followup.revision !== mutation.expectedRevision ||
      expected.revision !== mutation.expectedRevision ||
      !canonicalEqual(task.public_followup, expected)
    ) {
      throw new AxiError(
        `Public-followup "${id}" changed; retry the command`,
        "CONFLICT",
        ["Read the latest obligation revision, then retry"],
      );
    }
    if (task.state === "done") {
      throw new AxiError(
        `Public-followup "${id}" is already complete`,
        "CONFLICT",
      );
    }
    if (mutation.requireUnblocked) {
      const all = (await this.list({})).items;
      const byId = new Map(all.map((item) => [item.id, item]));
      const blocked = task.deps.some((dep) => {
        if (dep.type !== "blocked-by") return false;
        const blocker = byId.get(dep.id);
        return blocker !== undefined && blocker.state !== "done";
      });
      if (blocked) {
        throw new AxiError(
          "Cannot begin delivery while the obligation has an active blocker",
          "VALIDATION_ERROR",
        );
      }
    }

    const nextFollowup = normalizePublicFollowup(mutation.publicFollowup);
    assertPublicFollowupMutation(task.public_followup, nextFollowup);
    if (mutation.complete && !isPublicFollowupTerminal(nextFollowup)) {
      throw new AxiError(
        "Only a posted receipt or Captain-approved waiver may complete a public-followup",
        "VALIDATION_ERROR",
      );
    }
    if (!mutation.complete && isPublicFollowupTerminal(nextFollowup)) {
      throw new AxiError(
        "Terminal public-followup data requires an atomic completion mutation",
        "VALIDATION_ERROR",
      );
    }

    const next: Task = {
      ...task,
      deps: task.deps.map((dep) => ({ ...dep })),
      links: task.links.map((link) => ({ ...link })),
      public_followup: nextFollowup,
      ...(mutation.complete ? { state: "done" as State } : {}),
    };
    assertPublicFollowupTaskState(next.state, nextFollowup, id);

    const tables = await this.resolveTables();
    await this.request(
      ISSUE_UPDATE_MUTATION,
      {
        id: key,
        input: {
          description: renderDescription(next),
          ...(mutation.complete
            ? { stateId: this.stateId(tables, "done") }
            : {}),
        },
      },
      "public-followup",
    );
    this.invalidate();
    return (await this.get(id)) ?? next;
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * `prune` archives surplus completed issues in Linear, which is the direct
   * analogue of the markdown backend appending them to `done-archive.md`:
   * nothing is deleted and the issue stays recoverable, it just stops
   * appearing in the project view and in this backend's snapshot.
   */
  async prune(options: PruneOptions): Promise<PruneResult> {
    await this.requireOnline("prune");
    const items = (await this.list({})).items.filter(
      (task) => task.state === options.state,
    );
    const prunable = items.filter(
      (task) =>
        !(
          isPublicFollowupTask(task) &&
          task.public_followup &&
          !isPublicFollowupTerminal(task.public_followup)
        ),
    );
    const surplus = prunable.slice(Math.max(0, options.keep));
    for (const task of surplus) {
      await this.request(
        ISSUE_ARCHIVE_MUTATION,
        { id: task.meta?.linear_id as string },
        "prune",
      );
    }
    if (surplus.length > 0) this.invalidate();
    return { archived: surplus.length, ids: surplus.map((task) => task.id) };
  }

  /**
   * `render` re-syncs from Linear and rewrites the local mirror. The markdown
   * backend normalizes its file in place; here Linear is the source of truth,
   * so the equivalent normalization is to refresh the derived view.
   */
  async render(): Promise<number> {
    this.invalidate();
    const snapshot = await this.fetchSnapshot();
    return snapshot.issues.length;
  }

  // -------------------------------------------------------------------------
  // Cross-home move
  // -------------------------------------------------------------------------

  /**
   * Move a connected set of tasks into another Linear home.
   *
   * A home's partition is its project, so the move is a project reassignment
   * rather than a copy-and-delete: the issue keeps its identity, its history,
   * and - crucially - its blocking relations, which are properties of the
   * issue pair and not of the project. That is what preserves dependency edges
   * for free where the markdown backend has to re-render them.
   *
   * It is atomic because `issueBatchUpdate` reassigns the whole set in one
   * server-side request. A per-issue loop could fail halfway and leave one end
   * of a `blocked-by` edge in each home, which is exactly the split the
   * connected-set check below exists to prevent.
   */
  async moveManyTo(ids: string[], targetStore: Store): Promise<Task[]> {
    const target = requireLinearTarget(targetStore);
    const uniqueIds = [...new Set(ids)];
    await this.requireOnline(`move ${uniqueIds.join(", ")}`);

    const all = (await this.list({})).items;
    const moving = uniqueIds.map((id) => {
      const task = all.find((candidate) => candidate.id === id);
      if (!task) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
      return task;
    });

    const destination = (await target.list({})).items;
    for (const id of uniqueIds) {
      if (destination.some((task) => task.id === id)) {
        throw new AxiError(
          `Task "${id}" already exists in the destination home`,
          "CONFLICT",
        );
      }
    }

    requireNoSplitDeps(all, destination, uniqueIds);

    const tables = await target.resolveTables();
    const uuids = moving.map((task) => this.requireIssueUuid(task));
    await this.request(
      ISSUE_BATCH_UPDATE_MUTATION,
      {
        ids: uuids,
        input: {
          projectId: tables.projectId,
          // A cross-team move is legitimate (two homes may live in different
          // Linear teams); Linear re-keys the identifier, which costs nothing
          // because the tasks-axi slug is the join key.
          ...(target.team === this.team ? {} : { teamId: tables.teamId }),
        },
      },
      "mv",
    );

    this.invalidate();
    target.invalidate();
    // Re-sync both homes now rather than leaving each with no cache and no
    // mirror: a move is the one mutation with nothing to read back, and the
    // next command in either home would otherwise pay for the refetch and
    // find no mirror to fall back on offline.
    await this.fetchSnapshot();
    await target.fetchSnapshot();
    return moving;
  }

  /** Linear's UUID for a task, which is what a batch mutation addresses. */
  private requireIssueUuid(task: Task): string {
    const uuid = task.meta?.linear_uuid;
    if (typeof uuid !== "string" || uuid === "") {
      throw new AxiError(
        `Task "${task.id}" has no Linear issue id`,
        "UNKNOWN",
        ["Run `tasks-axi render` to refresh the snapshot, then retry"],
      );
    }
    return uuid;
  }
}

/**
 * A linear home can only move tasks into another linear home. The destination
 * arrives through the `Store` seam so the CLI stays backend-agnostic, which
 * means the backend has to assert its own type here.
 */
function requireLinearTarget(target: Store): LinearStore {
  if (target instanceof LinearStore) return target;
  throw crossBackendMove("linear", target.capabilities().backend);
}

/**
 * Refuse any move that would split a dependency edge across two homes, naming
 * the stranded id. This mirrors `MarkdownStore.requireNoSplitDeps` exactly,
 * because the rule is a property of the task graph rather than of a storage
 * format: a whole connected set moves together, or nothing moves.
 */
function requireNoSplitDeps(
  source: Task[],
  destination: Task[],
  ids: string[],
): void {
  const movedSet = new Set(ids);

  // (a) An active dependent left behind would point across homes at a blocker
  //     that is no longer in its partition.
  for (const id of ids) {
    const stranded = source
      .filter(
        (task) =>
          !movedSet.has(task.id) &&
          task.state !== "done" &&
          task.deps.some((dep) => dep.type === "blocked-by" && dep.id === id),
      )
      .map((task) => task.id);
    if (stranded.length > 0) {
      throw new AxiError(
        `Task "${id}" is still blocking active tasks: ${stranded.join(", ")}`,
        "VALIDATION_ERROR",
        [
          `Move them together, or unblock them first, e.g. \`tasks-axi unblock ${stranded[0]} --by ${id}\``,
        ],
      );
    }
  }

  // (b) A moved item's blocker must travel with it or already be in the
  //     destination; otherwise its `blocked-by` edge dangles across homes.
  for (const task of source.filter((candidate) => movedSet.has(candidate.id))) {
    for (const dep of task.deps) {
      if (movedSet.has(dep.id)) continue;
      if (destination.some((candidate) => candidate.id === dep.id)) continue;
      const label = dep.type === "blocked-by" ? "blocker" : "dependency";
      throw new AxiError(
        `Cannot move "${task.id}": its ${label} "${dep.id}" would be stranded (not in the moved set and absent from the destination)`,
        "VALIDATION_ERROR",
        [
          `Add "${dep.id}" to the same \`mv\`, or move it to the destination first`,
        ],
      );
    }
  }
}

/**
 * True when a failure means "could not reach Linear" rather than "Linear said
 * no". Only the first kind may fall back to a cached read; an auth failure or
 * a validation error must surface.
 */
function isOffline(error: unknown): boolean {
  if (error instanceof AxiError) return error.code === "NETWORK_ERROR";
  const code = (error as { code?: unknown })?.code;
  return code === "NETWORK_ERROR";
}
