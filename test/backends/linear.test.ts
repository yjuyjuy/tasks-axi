import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AxiError } from "../../src/errors.js";
import { LinearStore } from "../../src/backends/linear.js";
import {
  FakeLinear,
  OTHER_PROJECT,
  PROJECT,
  TEAM,
  meta,
} from "../linear-fake.js";

/**
 * The linear backend is tested against an injected fake client rather than the
 * network: the fake models Linear's response shapes and records every request,
 * which is what lets these tests assert the batching and offline guarantees
 * (DEV-44 acceptance criteria 3 and 4) deterministically in CI. The fake lives
 * in `test/linear-fake.ts` because the CLI-level tests need it too.
 */

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

  describe("priority mapping", () => {
    it("writes every priority inside Linear's 0-4 range and reads it back", async () => {
      const store = makeStore(0);
      for (const priority of [0, 1, 2, 3, 4]) {
        const id = `p-${priority}`;
        await store.create({ id, title: "t", priority });
        const issue = fake.issues.find((node) => node.title === "t" && node.description?.includes(`slug: ${id}`));
        expect(issue!.priority).toBeGreaterThanOrEqual(0);
        expect(issue!.priority).toBeLessThanOrEqual(4);
        // tasks-axi 0 and 1 both fold onto Linear's lowest real priority.
        expect((await store.get(id))?.priority).toBe(Math.max(1, priority));
      }
    });

    it("leaves priority unset when none is given, in both directions", async () => {
      const store = makeStore(0);
      await store.create({ id: "no-prio", title: "t" });
      expect(fake.issues[0]!.priority).toBe(0);
      expect((await store.get("no-prio"))?.priority).toBeUndefined();
    });

    it("keeps an updated priority inside Linear's range", async () => {
      const store = makeStore(0);
      await store.create({ id: "upd", title: "t", priority: 2 });
      for (const priority of [0, 1, 2, 3, 4]) {
        await store.update("upd", { priority });
        expect(fake.issues[0]!.priority).toBeGreaterThanOrEqual(0);
        expect(fake.issues[0]!.priority).toBeLessThanOrEqual(4);
        expect((await store.get("upd"))?.priority).toBe(Math.max(1, priority));
      }
    });
  });

  describe("unsupported operations", () => {
    it("rejects --archive-body rather than discarding the superseded body", async () => {
      const store = makeStore(0);
      await store.create({ id: "arch", title: "t", body: "original body" });
      await expect(
        store.update("arch", { body: "replacement", archiveBody: true }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      expect((await store.get("arch"))?.body).toBe("original body");
    });

    it("rejects a non-blocking dependency instead of posting a malformed relation", async () => {
      const store = makeStore(0);
      await store.create({ id: "child", title: "t" });
      await store.create({ id: "parent", title: "t2" });
      await expect(
        store.addDep("child", { type: "parent", id: "parent" }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      expect((await store.get("child"))?.deps).toEqual([]);
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

  describe("read-after-write", () => {
    it("reads a write back even while the disk cache is still fresh", async () => {
      // Caught live: with a 60s TTL, `add` created the issue and then read the
      // still-fresh cache back, which did not contain it, so the command failed
      // even though the write had succeeded.
      const store = makeStore(60);
      const created = await store.create({ id: "fresh-ttl", title: "t" });
      expect(created.id).toBe("fresh-ttl");
      expect(await store.get("fresh-ttl")).not.toBeNull();
    });

    it("reflects a transition immediately under a long TTL", async () => {
      const store = makeStore(60);
      await store.create({ id: "ttl-move", title: "t" });
      await store.transition("ttl-move", "in_flight");
      expect((await store.get("ttl-move"))?.state).toBe("in_flight");
    });

    it("lets a second process see the first process's write", async () => {
      await makeStore(60).create({ id: "cross-proc", title: "t" });
      // A fresh store shares only the on-disk cache, which the write refreshed.
      expect(await makeStore(60).get("cross-proc")).not.toBeNull();
    });
  });

  describe("kind parity with the markdown backend", () => {
    it("derives kind from a leading keyword when no tag is present", async () => {
      fake.seed({ identifier: "DEV-1", title: "SHIP Refactor the login flow" });
      const { items } = await makeStore().list({});
      expect(items[0]!.kind).toBe("ship");
    });

    it("prefers an explicit kind tag over the prose keyword", async () => {
      fake.seed({
        identifier: "DEV-1",
        title: "SHIP Refactor the login flow",
        description: ["```fm-meta", "slug: k", "kind: scout", "```"].join("\n"),
      });
      const { items } = await makeStore().list({});
      expect(items[0]!.kind).toBe("scout");
    });
  });

  describe("typed holds", () => {
    const labelsOf = (identifier: string): string[] =>
      (
        fake.issues.find((issue) => issue.identifier === identifier)?.labels
          .nodes ?? []
      ).map((node) => node.name);

    it("writes a Hold group label plus the reason and date in fm-meta", async () => {
      const store = makeStore(0);
      await store.create({ id: "held", title: "t" });
      await store.update("held", {
        hold: { reason: "captain decision pending", kind: "captain", until: "2026-09-10" },
      });

      // The label is what makes a hold filterable server-side in Linear, and
      // it is a child of the team's existing `Hold` group, not a flat name.
      expect(labelsOf("DEV-1")).toContain("Captain");
      expect(
        fake.labels.find((label) => label.name === "Captain")?.parent?.name,
      ).toBe("Hold");
      const task = await store.get("held");
      expect(task?.hold).toEqual({
        reason: "captain decision pending",
        kind: "captain",
        until: "2026-09-10",
      });
    });

    it("labels an untyped hold with the group's Unspecified child", async () => {
      const store = makeStore(0);
      await store.create({ id: "plain", title: "t" });
      await store.update("plain", { hold: { reason: "waiting" } });
      // Never the bare group name: Linear rejects assigning a group directly,
      // which is the live failure this case pins down.
      expect(labelsOf("DEV-1")).toContain("Unspecified");
      expect(labelsOf("DEV-1")).not.toContain("Hold");
    });

    it("reuses a hold child the team already created", async () => {
      const store = makeStore(0);
      await store.create({ id: "reuse", title: "t" });
      await store.update("reuse", { hold: { reason: "r", kind: "external" } });
      expect(labelsOf("DEV-1")).toContain("External");
      // `External` predates tasks-axi, so no duplicate is minted.
      expect(fake.labels.filter((label) => label.name === "External")).toHaveLength(1);
    });

    it("re-holding with the same kind and reason writes nothing", async () => {
      const store = makeStore(0);
      await store.create({ id: "idem", title: "t" });
      const hold = { reason: "r", kind: "captain" as const };
      await store.update("idem", { hold });

      fake.reset();
      const again = await store.update("idem", { hold });
      // No `changed` fields means no issueUpdate: idempotence is not "write
      // the same thing twice", it is "do not write at all".
      expect(again.changed).toEqual([]);
      expect(fake.calls.some((call) => call.operation === "update")).toBe(false);
      expect(labelsOf("DEV-1").filter((name) => name === "Captain")).toHaveLength(1);
    });

    it("swaps the label when the hold kind changes", async () => {
      const store = makeStore(0);
      await store.create({ id: "swap", title: "t" });
      await store.update("swap", { hold: { reason: "r", kind: "captain" } });
      await store.update("swap", { hold: { reason: "r", kind: "load" } });
      // A Linear label group is mutually exclusive, and so is a hold kind.
      expect(labelsOf("DEV-1")).toContain("Load");
      expect(labelsOf("DEV-1")).not.toContain("Captain");
    });

    it("clears the label on unhold and leaves the task otherwise intact", async () => {
      const store = makeStore(0);
      await store.create({ id: "clear", title: "t", repo: "tasks-axi" });
      await store.update("clear", { hold: { reason: "r", kind: "external" } });
      await store.update("clear", { hold: null });

      expect(labelsOf("DEV-1")).not.toContain("External");
      expect(labelsOf("DEV-1")).toContain("repo/tasks-axi");
      expect((await store.get("clear"))?.hold).toBeUndefined();
    });

    it("never assigns the group label itself, which Linear rejects", async () => {
      // Caught live: a flat label named `hold` collided with the team's
      // existing `Hold` group and Linear refused the write with "is a group
      // and cannot be assigned to issues directly". Every hold kind, and the
      // untyped case, must resolve to a child of that group.
      const store = makeStore(0);
      await store.create({ id: "group-safe", title: "t" });
      for (const kind of ["captain", "external", "load", "parked", "future"] as const) {
        await store.update("group-safe", { hold: { reason: "r", kind } });
        expect(labelsOf("DEV-1")).not.toContain("Hold");
      }
      await store.update("group-safe", { hold: { reason: "r" } });
      expect(labelsOf("DEV-1")).not.toContain("Hold");
      expect(labelsOf("DEV-1")).toContain("Unspecified");
    });

    it("cleans up a flat hold label written by an earlier build", async () => {
      fake.seed({
        identifier: "DEV-7",
        description: meta("legacy"),
        labels: { nodes: [{ id: "l-hold/captain", name: "hold/captain" }] },
      });
      const store = makeStore(0);
      await store.update("legacy", { hold: { reason: "r", kind: "parked" } });
      expect(labelsOf("DEV-7")).not.toContain("hold/captain");
      expect(labelsOf("DEV-7")).toContain("Parked");
    });

    it("preserves a human label whose name collides with a hold child", async () => {
      // A workspace may carry a top-level `Parked` a human created AND the
      // `Hold` group's own `Parked` child. Reconciling by name conflates the
      // two and silently drops the human's label on an unrelated update.
      fake.labels.push({ id: "l-human-parked", name: "Parked" });
      fake.seed({
        identifier: "DEV-11",
        description: meta("collide"),
        labels: {
          nodes: [
            { id: "l-human-parked", name: "Parked" },
            { id: "l-fm", name: "fm" },
          ],
        },
      });
      const store = makeStore(0);
      await store.update("collide", { repo: "tasks-axi" });

      const issue = fake.issues.find((node) => node.identifier === "DEV-11");
      const ids = (issue?.labels.nodes ?? []).map((node) => node.id);
      expect(ids).toContain("l-human-parked");
      expect(ids).not.toContain("l-Parked");
      expect(labelsOf("DEV-11")).toEqual(
        expect.arrayContaining(["Parked", "fm", "repo/tasks-axi"]),
      );
    });

    it("preserves labels tasks-axi does not manage", async () => {
      // A human's own label must survive a hold: `labelIds` is a replacement,
      // not a merge, so this is the regression that guards it.
      fake.seed({
        identifier: "DEV-9",
        description: meta("human"),
        labels: { nodes: [{ id: "l-Feature", name: "Feature" }, { id: "l-fm", name: "fm" }] },
      });
      const store = makeStore(0);
      await store.update("human", { hold: { reason: "r", kind: "captain" } });
      expect(labelsOf("DEV-9")).toEqual(
        expect.arrayContaining(["Feature", "fm", "Captain"]),
      );
    });
  });

  describe("cross-home mv", () => {
    const otherStore = (): LinearStore =>
      new LinearStore({
        team: TEAM,
        project: OTHER_PROJECT,
        cacheTtl: 0,
        mirrorPath: join(dir, "other", "backlog.md"),
        client: fake,
        now: () => "2026-06-01",
      });

    const projectOfIssue = (identifier: string): string | undefined =>
      fake.issues.find((issue) => issue.identifier === identifier)?.project?.name;

    it("moves a whole connected set and preserves its blocking edges", async () => {
      const store = makeStore(0);
      await store.create({ id: "a", title: "blocker" });
      await store.create({ id: "b", title: "sibling" });
      await store.create({ id: "c", title: "dependent" });
      await store.addDep("c", { type: "blocked-by", id: "a" });

      const other = otherStore();
      const moved = await store.moveManyTo(["a", "b", "c"], other);
      expect(moved.map((task) => task.id)).toEqual(["a", "b", "c"]);

      // Reassigned, not recreated: the relation is a property of the issue
      // pair, so the edge survives the move untouched.
      expect((await store.list({})).items).toEqual([]);
      const arrived = await other.get("c");
      expect(arrived?.deps).toEqual([{ type: "blocked-by", id: "a" }]);
      expect(projectOfIssue("DEV-1")).toBe(OTHER_PROJECT);
    });

    it("refuses a move that would strand a dependent, naming it", async () => {
      const store = makeStore(0);
      await store.create({ id: "a", title: "blocker" });
      await store.create({ id: "b", title: "sibling" });
      await store.create({ id: "c", title: "dependent" });
      await store.addDep("c", { type: "blocked-by", id: "a" });

      await expect(store.moveManyTo(["a", "b"], otherStore())).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("c"),
      });
      // Nothing moved: the check runs before any write.
      expect(projectOfIssue("DEV-1")).toBe(PROJECT);
      expect(projectOfIssue("DEV-2")).toBe(PROJECT);
    });

    it("refuses a move whose blocker would be left behind, naming it", async () => {
      const store = makeStore(0);
      await store.create({ id: "a", title: "blocker" });
      await store.create({ id: "c", title: "dependent" });
      await store.addDep("c", { type: "blocked-by", id: "a" });

      await expect(store.moveManyTo(["c"], otherStore())).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("stranded"),
      });
    });

    it("moves the whole set in one batched request", async () => {
      const store = makeStore(0);
      await store.create({ id: "a", title: "t" });
      await store.create({ id: "b", title: "t" });
      fake.reset();
      await store.moveManyTo(["a", "b"], otherStore());
      // One mutation for the set, not one per issue: a partial failure would
      // split the very edges the connected-set check protects.
      expect(fake.calls.filter((call) => call.operation === "mv")).toHaveLength(1);
    });

    it("refuses a destination that already holds the id", async () => {
      const store = makeStore(0);
      await store.create({ id: "dup", title: "t" });
      const other = otherStore();
      fake.seed({
        identifier: "DEV-99",
        description: meta("dup"),
        project: { name: OTHER_PROJECT },
      });
      await expect(store.moveManyTo(["dup"], other)).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });

    it("lets the next process in either home see the move", async () => {
      // Caught live: `mv` is the one mutation with nothing to read back, so a
      // pre-move snapshot survived on disk and the next process in BOTH homes
      // still listed the old contents for the whole TTL. A long TTL is the
      // point of the test - a 0 TTL would hide the bug.
      const store = new LinearStore({
        team: TEAM,
        project: PROJECT,
        cacheTtl: 600,
        mirrorPath: mirror,
        client: fake,
        now: () => "2026-06-01",
      });
      await store.create({ id: "a", title: "t" });
      const otherMirror = join(dir, "other", "backlog.md");
      const makeOther = (): LinearStore =>
        new LinearStore({
          team: TEAM,
          project: OTHER_PROJECT,
          cacheTtl: 600,
          mirrorPath: otherMirror,
          client: fake,
          now: () => "2026-06-01",
        });
      const other = makeOther();
      await other.list({});
      await store.moveManyTo(["a"], other);

      // Fresh stores are fresh processes: only the on-disk cache carries over.
      const sourceAfter = new LinearStore({
        team: TEAM,
        project: PROJECT,
        cacheTtl: 600,
        mirrorPath: mirror,
        client: fake,
        now: () => "2026-06-01",
      });
      expect((await sourceAfter.list({})).items).toEqual([]);
      expect((await makeOther().list({})).items.map((task) => task.id)).toEqual(["a"]);
    });

    it("fails loud rather than half-moving when Linear is unreachable", async () => {
      const store = makeStore(0);
      await store.create({ id: "a", title: "t" });
      fake.offline = true;
      await expect(store.moveManyTo(["a"], otherStore())).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
    });
  });

});
