import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinearStore } from "../../src/backends/linear.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import type { ResolvedConfig } from "../../src/config.js";
import {
  holdCommand,
  mvCommand,
  readyCommand,
  unholdCommand,
} from "../../src/commands/state.js";
import type { TasksContext } from "../../src/context.js";
import type { Store } from "../../src/store.js";
import { FakeLinear, OTHER_PROJECT, PROJECT, TEAM } from "../linear-fake.js";
import { makeBacklog } from "../helpers.js";

/**
 * The CLI verbs against a linear home (ticket DEV-45).
 *
 * These sit above `test/backends/linear.test.ts`: that file proves the backend
 * writes the right labels and issues one batched move, while these prove the
 * command layer behaves - `hold` twice is a no-op, an expired `--until` frees
 * a task with no write at all, and `mv` across backends is refused.
 */

const HOME = ".tasks.toml";

describe("linear-backed state commands", () => {
  let dir: string;
  let fake: FakeLinear;

  const config = (project: string): ResolvedConfig => ({
    backend: "linear",
    path: join(dir, project.replace(/\s+/g, "-"), "backlog.md"),
    doneKeep: 10,
    linear: {
      team: TEAM,
      project,
      cacheTtl: 0,
      mirrorPath: join(dir, project.replace(/\s+/g, "-"), "backlog.md"),
    },
  });

  /** Every store in these tests shares the one fake client. */
  const storeFactory = (resolved: ResolvedConfig): Store =>
    resolved.backend === "linear"
      ? new LinearStore({
          team: resolved.linear!.team,
          project: resolved.linear!.project,
          cacheTtl: 0,
          mirrorPath: resolved.linear!.mirrorPath,
          client: fake,
          now: () => "2026-06-01",
        })
      : new MarkdownStore({ path: resolved.path });

  const makeContext = (project = PROJECT): TasksContext => {
    const resolved = config(project);
    return { store: storeFactory(resolved), config: resolved, storeFactory };
  };

  /** A destination home directory whose own `.tasks.toml` selects a backend. */
  const makeHomeDir = (name: string, toml: string): string => {
    const home = join(dir, name);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, HOME), toml, "utf8");
    return home;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tasks-axi-linear-cli-"));
    fake = new FakeLinear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("hold", () => {
    it("is a no-op the second time, hides the task from ready, and unhold restores it", async () => {
      const ctx = makeContext();
      await ctx.store.create({ id: "held-x", title: "work" });

      const first = await holdCommand(
        ["held-x", "--kind", "captain", "--reason", "captain decision pending"],
        ctx,
      );
      expect(first).toContain("ok: hold held-x -> held (captain)");
      expect(await readyCommand([], ctx)).toContain("ready: 0 unblocked");

      fake.reset();
      const second = await holdCommand(
        ["held-x", "--kind", "captain", "--reason", "captain decision pending"],
        ctx,
      );
      expect(second).toContain("ok: hold held-x already held");
      // Idempotence is "no write happened", not "the same write happened twice".
      expect(fake.calls.some((call) => call.operation === "update")).toBe(false);

      const cleared = await unholdCommand(["held-x"], ctx);
      expect(cleared).toContain("ok: unhold held-x -> cleared");
      expect(await readyCommand([], ctx)).toContain("held-x");
    });

    it("self-releases an expired --until with no write at all", async () => {
      const ctx = makeContext();
      await ctx.store.create({ id: "expiring", title: "work" });
      await holdCommand(
        ["expiring", "--reason", "waiting on the vendor", "--until", "2000-01-01"],
        ctx,
      );

      fake.reset();
      const ready = await readyCommand([], makeContext());
      expect(ready).toContain("expiring");
      // The date gate is evaluated client-side in `derive.ts`, so an expired
      // hold costs a read and nothing else - no issue is ever mutated.
      const mutations = fake.calls.filter(
        (call) => !["sync", "resolve"].includes(call.operation),
      );
      expect(mutations).toEqual([]);
    });
  });

  describe("mv", () => {
    it("moves a connected set between linear homes and keeps the edge", async () => {
      const ctx = makeContext();
      await ctx.store.create({ id: "a", title: "blocker" });
      await ctx.store.create({ id: "b", title: "sibling" });
      await ctx.store.create({ id: "c", title: "dependent" });
      await ctx.store.addDep("c", { type: "blocked-by", id: "a" });

      const home = makeHomeDir(
        "other-home",
        [
          'backend = "linear"',
          "[linear]",
          `team = "${TEAM}"`,
          `project = "${OTHER_PROJECT}"`,
          "cache_ttl = 0",
        ].join("\n"),
      );

      const out = await mvCommand(["a", "b", "c", "--to", home], ctx);
      expect(out).toContain(`ok: mv a b c -> ${TEAM}/${OTHER_PROJECT}`);

      const other = makeContext(OTHER_PROJECT);
      const moved = await other.store.get("c");
      expect(moved?.deps).toEqual([{ type: "blocked-by", id: "a" }]);
      expect((await ctx.store.list({})).items).toEqual([]);
    });

    it("refuses to strand a dependent and names it", async () => {
      const ctx = makeContext();
      await ctx.store.create({ id: "a", title: "blocker" });
      await ctx.store.create({ id: "b", title: "sibling" });
      await ctx.store.create({ id: "c", title: "dependent" });
      await ctx.store.addDep("c", { type: "blocked-by", id: "a" });

      const home = makeHomeDir(
        "strand-home",
        [
          'backend = "linear"',
          "[linear]",
          `team = "${TEAM}"`,
          `project = "${OTHER_PROJECT}"`,
        ].join("\n"),
      );

      await expect(mvCommand(["a", "b", "--to", home], ctx)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("c"),
      });
      expect((await ctx.store.list({})).items).toHaveLength(3);
    });

    it("refuses a move from a linear home to a markdown home", async () => {
      const ctx = makeContext();
      await ctx.store.create({ id: "a", title: "work" });
      const home = makeHomeDir("markdown-home", 'backend = "markdown"');

      await expect(mvCommand(["a", "--to", home], ctx)).rejects.toMatchObject({
        code: "UNSUPPORTED",
        message: expect.stringMatching(/linear home to a markdown home/),
        suggestions: expect.arrayContaining([
          expect.stringContaining("must share a backend"),
        ]),
      });
      // Refused before any write: the task is still in its original home.
      expect((await ctx.store.list({})).items).toHaveLength(1);
    });

    it("refuses a move from a markdown home to a linear home", async () => {
      const b = makeBacklog();
      const home = makeHomeDir(
        "linear-home",
        [
          'backend = "linear"',
          "[linear]",
          `team = "${TEAM}"`,
          `project = "${OTHER_PROJECT}"`,
        ].join("\n"),
      );
      try {
        await expect(
          mvCommand(["cert-cleanup", "--to", home], { ...b.ctx, storeFactory }),
        ).rejects.toMatchObject({
          code: "UNSUPPORTED",
          message: expect.stringMatching(/markdown home to a linear home/),
        });
        expect(b.read()).toContain("cert-cleanup");
      } finally {
        b.cleanup();
      }
    });
  });
});
