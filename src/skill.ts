// Trigger string agents match against to auto-load the skill. Terse and
// outcome-focused so it fires on "manage the backlog / track tasks" intents.
export const SKILL_DESCRIPTION =
  "Manage a task backlog through the tasks-axi CLI - add, list, show, start, " +
  "and complete tasks; track blocked-by dependencies, structured holds, and a " +
  "ready queue; prune and normalize a hand-editable backlog.md. Use whenever a task touches " +
  "backlog or task state: filing or dispatching work, recording a PR or report " +
  "on completion, finding dispatchable or held work, or trimming the Done list.";

export const SKILL_AUTHOR = "Kun Chen (kunchenguid)";

// Extended frontmatter read by Nous Research's Hermes Agent harness; harnesses
// that don't know these fields (e.g. Claude Code) ignore them.
export const HERMES_TAGS = ["tasks", "backlog", "planning", "dependencies"];
export const HERMES_CATEGORY = "productivity";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render the installable SKILL.md.
 *
 * Shape follows the fleet's five-section CLI skill template: trigger
 * description, when to reach for it, curated workflows, fleet conventions
 * `--help` cannot know, and non-goals. Help-derivable content is banned - no
 * flag lists, no usage lines, nothing that restates `--help`. tasks-axi is a
 * high-compliance AXI tool, so this stays a stub: the CLI documents itself and
 * an installed skill goes stale when the npm package is bumped.
 */
export function createSkillMarkdown(): string {
  return `---
name: tasks-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${HERMES_TAGS.join(", ")}]
    category: ${HERMES_CATEGORY}
---

# tasks-axi

Agent ergonomic backlog CLI. Prefer it over hand-editing \`backlog.md\` for any task state, dependency, or hold change.

Run it bare and read the dashboard; every response ends with \`help:\` hints, and every command takes \`--help\`. That is the source of truth for commands and flags.
If the binary is not on \`PATH\`, run every command as \`npx -y tasks-axi ...\` instead.

## When to reach for it

- Local agent work queues: this tool. Linear tickets: \`linear-axi\`. GitHub issues and PRs: \`gh-axi\`.
- Reads are cheap and unlocked; a bare \`tasks-axi list\` is the dispatch view (ready work only), so re-checking the queue costs almost nothing.

## Workflows

\`\`\`bash
tasks-axi ready                                   # what is dispatchable right now
tasks-axi show <id> --full                        # whole body before editing or dispatching
tasks-axi add <id> "<title>" --blocked-by <other> # file work behind its blocker
tasks-axi start <id> && tasks-axi done <id> --pr <url>   # dispatch, then close with evidence
tasks-axi hold <id> --reason "<text>" --kind captain     # park it out of the ready queue
tasks-axi list --state held --fields hold_kind,hold_reason  # review what is parked and why
\`\`\`

## Fleet conventions

- **Ids are the Linear key, lowercased** (\`dev-52\`), with a letter suffix per split (\`dev-52a\`). Non-ticket work gets a descriptive slug (\`fm-pr-target-guard\`). Reach for \`--mint\` only when no ticket and no obvious slug exists.
- **One backlog per firstmate home; there is no global backlog.** Commands act on the backlog of the current directory's workspace, so operating on another home means passing \`--file <home>/data/backlog.md\` on every call. Flags must follow the command, not precede it.
- **Hold kinds mean:** \`captain\` awaits a human decision, \`external\` awaits something outside the fleet, \`load\` waits for capacity, \`parked\` is deliberately shelved, \`future\` is not yet due (pair with \`--until\`).
- **Never close a \`captain\` hold with a bare \`done\`.** Firstmate's \`bin/fm-decision-hold.sh close <id>\` is the safe path; a bare \`done\` can bury an unresolved decision in the retention archive where it is no longer addressable.

## Non-goals

- Not a \`--help\` replacement: flags, output schemas, and error codes come from the CLI itself.
- Not a general note store, and not a cross-home tracker; use \`mv\` for a deliberate cross-file move.
- Not a markdown editor: the backlog file stays hand-readable, but let the CLI do the writing so the round-trip stays byte-exact.
`;
}
