import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AxiError } from "../../src/errors.js";
import { LinearStore } from "../../src/backends/linear.js";
import type { LinearClientLike } from "../../src/backends/linear-client.js";
import type { LinearIssueNode } from "../../src/backends/linear-map.js";

/**
 * The linear backend is tested against an injected fake client rather than the
 * network: the fake models Linear's response shapes and records every request,
 * which is what lets these tests assert the batching and offline guarantees
 * (DEV-44 acceptance criteria 3 and 4) deterministically in CI.
 */

const TEAM = "DEV";
const PROJECT = "Test Home";

/** An `fm-meta` description carrying just the slug join key. */
const meta = (slug: string): string => ["```fm-meta", `slug: ${slug}`, "```"].join("\n");

/**
 * Label ids round-trip back to names the way Linear does. The backend mints an
 * id of `l-<name>` for a label it creates, so the name is recoverable.
 */
const labelNodes = (ids: string[] | undefined): { name: string }[] =>
  (ids ?? []).map((id) => ({ name: id.replace(/^l-/, "") }));

interface FakeOptions {
  /** Fail every request with a network error, simulating a blocked network. */
  offline?: boolean;
}

class FakeLinear implements LinearClientLike {
  /** Every request, in order, as `operation` labels. */
  readonly calls: { operation: string; query: string }[] = [];
  issues: LinearIssueNode[] = [];
  offline = false;
  private seq = 0;
  private relations: { id: string; blocked: string; blocker: string }[] = [];

  constructor(options: FakeOptions = {}) {
    this.offline = options.offline ?? false;
  }

  /** Requests that actually crossed the wire, for batching assertions. */
  get requestCount(): number {
    return this.calls.length;
  }

  get syncCount(): number {
    return this.calls.filter((call) => call.operation === "sync").length;
  }

  reset(): void {
    this.calls.length = 0;
  }

  seed(issue: Partial<LinearIssueNode> & { identifier: string }): LinearIssueNode {
    const node: LinearIssueNode = {
      identifier: issue.identifier,
      title: issue.title ?? "untitled",
      description: issue.description ?? null,
      url: issue.url ?? `https://linear.app/x/issue/${issue.identifier}`,
      priority: issue.priority ?? 0,
      createdAt: issue.createdAt ?? "2026-01-01T00:00:00.000Z",
      updatedAt: issue.updatedAt ?? "2026-01-01T00:00:00.000Z",
      state: issue.state ?? { name: "Todo", type: "unstarted" },
      labels: issue.labels ?? { nodes: [] },
      project: issue.project ?? { name: PROJECT },
      inverseRelations: issue.inverseRelations ?? { nodes: [] },
    };
    this.issues.push(node);
    return node;
  }

  private withRelations(): LinearIssueNode[] {
    return this.issues.map((issue) => ({
      ...issue,
      inverseRelations: {
        nodes: this.relations
          .filter((relation) => relation.blocked === issue.identifier)
          .map((relation) => ({
            type: "blocks",
            issue: { identifier: relation.blocker },
          })),
      },
    }));
  }

  async request<T>(
    query: string,
    variables: Record<string, unknown>,
    operation: string,
  ): Promise<T> {
    if (this.offline) {
      throw new AxiError("connect ENETUNREACH", "NETWORK_ERROR");
    }
    this.calls.push({ operation, query });

    if (query.includes("issues(")) {
      return {
        issues: {
          nodes: this.withRelations(),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      } as T;
    }
    if (query.includes("team(")) {
      return {
        team: {
          id: "team-1",
          key: TEAM,
          states: {
            nodes: [
              { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
              { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
              // Two started states: the lowest position must win, and the
              // names here are deliberately non-default to prove names are
              // never matched on.
              { id: "s-doing", name: "Cooking", type: "started", position: 1 },
              { id: "s-pr", name: "PR Ready", type: "started", position: 2 },
              { id: "s-done", name: "Shipped", type: "completed", position: 3 },
            ],
          },
          labels: { nodes: [{ id: "l-fm", name: "fm" }] },
          projects: { nodes: [{ id: "proj-1", name: PROJECT }] },
        },
      } as T;
    }
    if (query.includes("issueCreate")) {
      const input = variables.input as Record<string, unknown>;
      const stateNode = {
        "s-todo": { name: "Todo", type: "unstarted" },
        "s-doing": { name: "Cooking", type: "started" },
        "s-done": { name: "Shipped", type: "completed" },
      }[input.stateId as string] ?? { name: "Todo", type: "unstarted" };
      const node = this.seed({
        identifier: `${TEAM}-${++this.seq}`,
        title: input.title as string,
        description: input.description as string,
        state: stateNode,
        priority: Number(input.priority ?? 0),
        labels: { nodes: labelNodes(input.labelIds as string[] | undefined) },
      });
      return { issueCreate: { success: true, issue: node } } as T;
    }
    if (query.includes("issueUpdate")) {
      const id = variables.id as string;
      const input = variables.input as Record<string, string>;
      const issue = this.issues.find((node) => node.identifier === id);
      if (!issue) throw new AxiError("no such issue", "NOT_FOUND");
      if (input.title !== undefined) issue.title = input.title;
      if (input.description !== undefined) issue.description = input.description;
      if (input.stateId !== undefined) {
        issue.state = {
          "s-todo": { name: "Todo", type: "unstarted" },
          "s-doing": { name: "Cooking", type: "started" },
          "s-done": { name: "Shipped", type: "completed" },
        }[input.stateId] ?? issue.state;
      }
      if (input.priority !== undefined) issue.priority = Number(input.priority);
      issue.updatedAt = new Date(Date.now() + this.seq).toISOString();
      return { issueUpdate: { success: true, issue } } as T;
    }
    if (query.includes("issueArchive")) {
      const id = variables.id as string;
      this.issues = this.issues.filter((node) => node.identifier !== id);
      return { issueArchive: { success: true } } as T;
    }
    if (query.includes("issueLabelCreate")) {
      const input = variables.input as Record<string, string>;
      return {
        issueLabelCreate: {
          success: true,
          issueLabel: { id: `l-${input.name}`, name: input.name },
        },
      } as T;
    }
    if (query.includes("issueRelationCreate")) {
      const input = variables.input as Record<string, string>;
      this.relations.push({
        id: `rel-${this.relations.length + 1}`,
        blocked: input.relatedIssueId,
        blocker: input.issueId,
      });
      return { issueRelationCreate: { success: true } } as T;
    }
    if (query.includes("issueRelationDelete")) {
      const id = variables.id as string;
      this.relations = this.relations.filter((relation) => relation.id !== id);
      return { issueRelationDelete: { success: true } } as T;
    }
    if (query.includes("inverseRelations")) {
      const id = variables.id as string;
      return {
        issue: {
          inverseRelations: {
            nodes: this.relations
              .filter((relation) => relation.blocked === id)
              .map((relation) => ({
                id: relation.id,
                type: "blocks",
                issue: { identifier: relation.blocker },
              })),
          },
        },
      } as T;
    }
    throw new Error(`unhandled query: ${query.slice(0, 60)}`);
  }
}

describe("linear backend", () => {
  let dir: string;
  let mirror: string;
  let fake: FakeLinear;

  const makeStore = (cacheTtl = 60): LinearStore =>
    new LinearStore({
      team: TEAM,
      project: PROJECT,
      cacheTtl,
      mirrorPath: mirror,
      client: fake,
      now: () => "2026-06-01",
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tasks-axi-linear-"));
    mirror = join(dir, "data", "backlog.md");
    fake = new FakeLinear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("state mapping", () => {
    it("maps every Linear state type onto a tasks-axi state", async () => {
      fake.seed({ identifier: "DEV-1", state: { name: "Backlog", type: "backlog" } });
      fake.seed({ identifier: "DEV-2", state: { name: "Todo", type: "unstarted" } });
      fake.seed({ identifier: "DEV-3", state: { name: "Triage", type: "triage" } });
      fake.seed({ identifier: "DEV-4", state: { name: "Doing", type: "started" } });
      fake.seed({ identifier: "DEV-5", state: { name: "Done", type: "completed" } });
      fake.seed({ identifier: "DEV-6", state: { name: "Canceled", type: "canceled" } });

      const { items } = await makeStore().list({});
      expect(items.map((task) => task.state)).toEqual([
        "queued",
        "queued",
        "queued",
        "in_flight",
        "done",
        "done",
      ]);
    });

    it("reads state by type, so renaming a workflow state changes nothing", async () => {
      // The same issue, with the display name a human might rename at will.
      fake.seed({
        identifier: "DEV-1",
        state: { name: "In Progress", type: "started" },
      });
      const before = await makeStore().list({});

      fake.issues[0]!.state = { name: "Cooking 🔥", type: "started" };
      fake.issues[0]!.updatedAt = "2026-02-01T00:00:00.000Z";
      const after = await makeStore(0).list({});

      expect(before.items[0]!.state).toBe("in_flight");
      expect(after.items[0]!.state).toBe("in_flight");
    });

    it("writes state by type and picks the lowest-positioned match", async () => {
      const store = makeStore(0);
      await store.create({ id: "task-a", title: "a" });
      await store.transition("task-a", "in_flight");
      // "Cooking" (position 1) beats "PR Ready" (position 2); neither is named
      // "In Progress", so a name-based lookup would have failed here.
      expect(fake.issues[0]!.state).toEqual({ name: "Cooking", type: "started" });
    });
  });

  describe("round-trip", () => {
    it("preserves every task field through a create/read cycle", async () => {
      const store = makeStore(0);
      await store.create({
        id: "round-trip",
        title: "Ship the thing",
        kind: "SHIP",
        repo: "tasks-axi",
        priority: 1,
        body: "Some detail.\nOn two lines.",
        resume: "pick up at step 3",
      });

      const task = await store.get("round-trip");
      expect(task).toMatchObject({
        id: "round-trip",
        title: "Ship the thing",
        kind: "SHIP",
        repo: "tasks-axi",
        priority: 1,
        body: "Some detail.\nOn two lines.",
        resume: "pick up at step 3",
        state: "queued",
        created: "2026-06-01",
      });
    });

    it("carries the tasks-axi id as the join key, not Linear's identifier", async () => {
      const store = makeStore(0);
      const created = await store.create({ id: "join-key", title: "t" });
      expect(created.id).toBe("join-key");
      expect(created.meta?.linear_id).toBe("DEV-1");
    });

    it("round-trips a blocking edge and its reason", async () => {
      const store = makeStore(0);
      await store.create({ id: "blocker", title: "first" });
      await store.create({ id: "blocked", title: "second" });
      await store.addDep("blocked", {
        type: "blocked-by",
        id: "blocker",
        reason: "waits on the refactor",
      });

      const task = await store.get("blocked");
      expect(task?.deps).toEqual([
        { type: "blocked-by", id: "blocker", reason: "waits on the refactor" },
      ]);
    });

    it("removes a blocking edge by its relation id", async () => {
      const store = makeStore(0);
      await store.create({ id: "blocker", title: "first" });
      await store.create({ id: "blocked", title: "second" });
      await store.addDep("blocked", { type: "blocked-by", id: "blocker" });
      expect(await store.removeDep("blocked", { type: "blocked-by", id: "blocker" })).toBe(true);
      expect((await store.get("blocked"))?.deps).toEqual([]);
    });
  });

  describe("request batching", () => {
    it("reads the whole backlog in a single request", async () => {
      for (let i = 1; i <= 20; i++) fake.seed({ identifier: `DEV-${i}` });
      fake.reset();

      const store = makeStore();
      await store.list({});
      expect(fake.syncCount).toBe(1);
    });

    it("serves repeated reads in one process from the same snapshot", async () => {
      for (let i = 1; i <= 20; i++) {
        fake.seed({
          identifier: `DEV-${i}`,
          description: meta(`task-${i}`),
        });
      }
      fake.reset();

      const store = makeStore();
      for (let i = 1; i <= 20; i++) await store.get(`task-${i}`);
      // 20 `show` reads, one request: this is the guarantee that makes a
      // dispatch loop affordable.
      expect(fake.syncCount).toBe(1);
    });

    it("serves a second process from the disk cache with no request at all", async () => {
      fake.seed({ identifier: "DEV-1", description: meta("a") });
      await makeStore().list({});
      fake.reset();

      // A fresh store is a fresh process: only the on-disk cache carries over.
      await makeStore().list({});
      expect(fake.requestCount).toBe(0);
    });

    it("refetches once the TTL has expired", async () => {
      fake.seed({ identifier: "DEV-1" });
      await makeStore(0).list({});
      fake.reset();
      await makeStore(0).list({});
      expect(fake.syncCount).toBe(1);
    });
  });

  describe("offline behaviour", () => {
    it("serves reads from the cached snapshot when Linear is unreachable", async () => {
      fake.seed({ identifier: "DEV-1", title: "cached work", description: meta("cached") });
      await makeStore().list({});

      fake.offline = true;
      const { items } = await makeStore(0).list({});
      expect(items.map((task) => task.id)).toEqual(["cached"]);
    });

    it("serves reads from the markdown mirror when the cache is gone", async () => {
      fake.seed({ identifier: "DEV-1", title: "mirrored work", description: meta("mirrored") });
      await makeStore().list({});
      rmSync(`${mirror}.cache.json`, { force: true });

      fake.offline = true;
      const { items } = await makeStore(0).list({});
      expect(items.map((task) => task.id)).toEqual(["mirrored"]);
      expect(items[0]!.title).toBe("mirrored work");
    });

    it("writes a mirror that is a readable markdown backlog", async () => {
      fake.seed({
        identifier: "DEV-1",
        title: "queued work",
        description: meta("queued-one"),
      });
      fake.seed({
        identifier: "DEV-2",
        title: "active work",
        state: { name: "Doing", type: "started" },
        description: meta("active-one"),
      });
      await makeStore().list({});

      const text = readFileSync(mirror, "utf8");
      expect(text).toContain("## In flight");
      expect(text).toContain("- [ ] active-one - active work");
      expect(text).toContain("## Queued");
      expect(text).toContain("- [ ] queued-one - queued work");
      // The banner is what stops a human treating the mirror as a write target.
      expect(text).toContain("Read-only");
    });

    it("fails a mutation loudly instead of diverging from the tracker", async () => {
      fake.seed({ identifier: "DEV-1", description: meta("a") });
      await makeStore().list({});

      fake.offline = true;
      const store = makeStore(0);
      await expect(store.transition("a", "in_flight")).rejects.toThrow(/offline/i);
      await expect(store.create({ id: "b", title: "t" })).rejects.toThrow(/offline/i);
    });

    it("does not mistake an auth failure for being offline", async () => {
      fake.seed({ identifier: "DEV-1" });
      await makeStore().list({});
      // An auth error must surface, not silently serve stale data.
      fake.request = async () => {
        throw new AxiError("bad api key", "AUTH_REQUIRED");
      };
      await expect(makeStore(0).list({})).rejects.toThrow(/bad api key/);
    });
  });

  describe("lifecycle", () => {
    it("transitions through the full state machine", async () => {
      const store = makeStore(0);
      await store.create({ id: "life", title: "t" });
      expect((await store.get("life"))?.state).toBe("queued");
      await store.transition("life", "in_flight");
      expect((await store.get("life"))?.state).toBe("in_flight");
      await store.transition("life", "done");
      expect((await store.get("life"))?.state).toBe("done");
      await store.transition("life", "queued");
      expect((await store.get("life"))?.state).toBe("queued");
    });

    it("refuses to remove a task that still blocks an active dependent", async () => {
      const store = makeStore(0);
      await store.create({ id: "blocker", title: "first" });
      await store.create({ id: "blocked", title: "second" });
      await store.addDep("blocked", { type: "blocked-by", id: "blocker" });
      await expect(store.remove("blocker")).rejects.toThrow(/still blocking/);
    });

    it("rejects a dependency on a task that does not exist", async () => {
      const store = makeStore(0);
      await store.create({ id: "solo", title: "t" });
      await expect(
        store.addDep("solo", { type: "blocked-by", id: "ghost" }),
      ).rejects.toThrow(/not found/);
    });

    it("archives surplus done tasks on prune rather than deleting them", async () => {
      const store = makeStore(0);
      for (const id of ["d1", "d2", "d3"]) {
        await store.create({ id, title: id, state: "done" });
      }
      const result = await store.prune({ state: "done", keep: 1 });
      expect(result.archived).toBe(2);
      expect((await store.list({ state: "done" })).items).toHaveLength(1);
    });
  });

  describe("config resilience", () => {
    it("ignores a hand-edited description instead of failing the read", async () => {
      fake.seed({
        identifier: "DEV-1",
        title: "hand edited",
        description: "Someone deleted the metadata block and wrote prose.",
      });
      const { items } = await makeStore().list({});
      // No metadata means no slug, so the Linear identifier is the fallback id;
      // the important part is that the read does not throw.
      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe("hand edited");
    });

    it("survives an unterminated metadata fence", async () => {
      fake.seed({
        identifier: "DEV-1",
        title: "broken fence",
        description: "```fm-meta\nslug: broken",
      });
      const { items } = await makeStore().list({});
      expect(items).toHaveLength(1);
    });

    it("ignores a corrupt cache file and refetches", async () => {
      fake.seed({ identifier: "DEV-1" });
      await makeStore().list({});
      writeFileSync(`${mirror}.cache.json`, "{not json");
      fake.reset();
      const { items } = await makeStore().list({});
      expect(items).toHaveLength(1);
      expect(fake.syncCount).toBe(1);
    });
  });
});
