import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSkillMarkdown, SKILL_DESCRIPTION } from "../src/skill.js";

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

describe("skill generation", () => {
  it("keeps frontmatter identity and the five-section template", () => {
    const md = createSkillMarkdown();
    expect(md.startsWith("---\nname: tasks-axi\n")).toBe(true);
    expect(md).toContain(JSON.stringify(SKILL_DESCRIPTION));
    expect(md).toContain("metadata:");
    for (const heading of [
      "## When to reach for it",
      "## Workflows",
      "## Fleet conventions",
      "## Non-goals",
    ]) {
      expect(md).toContain(heading);
    }
  });

  it("stays a stub: body is short and carries no flag reference", () => {
    const body = createSkillMarkdown().split("\n---\n")[1] ?? "";
    const lines = body.split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeLessThanOrEqual(30);
    expect(body).not.toContain("usage:");
    expect(body).not.toMatch(/^flags:/m);
    expect(body).not.toMatch(/^commands\[\d+\]:/m);
  });

  it("matches the committed skill file (guards against drift)", () => {
    const committed = readFileSync(
      new URL("../.agents/skills/tasks-axi/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(normalizeLineEndings(committed)).toBe(createSkillMarkdown());
  });
});
