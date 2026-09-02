---
name: tasks-axi
description: "Manage a task backlog through the tasks-axi CLI - add, list, show, start, and complete tasks; track blocked-by dependencies, structured holds, and a ready queue; prune and normalize a hand-editable backlog.md. Use whenever a task touches backlog or task state: filing or dispatching work, recording a PR or report on completion, finding dispatchable or held work, or trimming the Done list."
user-invocable: false
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [tasks, backlog, planning, dependencies]
    category: productivity
---

# tasks-axi

Agent ergonomic backlog CLI. Prefer it over hand-editing `backlog.md` for any task state, dependency, or hold change.

Run it bare and read the dashboard; every response ends with `help:` hints, and every command takes `--help`. That is the source of truth for commands and flags.
If the binary is not on `PATH`, run every command as `npx -y tasks-axi ...` instead.

## When to reach for it

- Local agent work queues: this tool. Linear tickets: `linear-axi`. GitHub issues and PRs: `gh-axi`.
- Reads are cheap and unlocked; a bare `tasks-axi list` is the dispatch view (ready work only), so re-checking the queue costs almost nothing.

## Workflows

```bash
tasks-axi ready                                   # what is dispatchable right now
tasks-axi show <id> --full                        # whole body before editing or dispatching
tasks-axi add <id> "<title>" --blocked-by <other> # file work behind its blocker
tasks-axi start <id> && tasks-axi done <id> --pr <url>   # dispatch, then close with evidence
tasks-axi hold <id> --reason "<text>" --kind captain     # park it out of the ready queue
tasks-axi list --state held --fields hold_kind,hold_reason  # review what is parked and why
```

## Fleet conventions

- **Ids are the Linear key, lowercased** (`dev-52`), with a letter suffix per split (`dev-52a`). Non-ticket work gets a descriptive slug (`fm-pr-target-guard`). Reach for `--mint` only when no ticket and no obvious slug exists.
- **One backlog per firstmate home; there is no global backlog.** Commands act on the backlog of the current directory's workspace, so operating on another home means passing `--file <home>/data/backlog.md` on every call. Flags must follow the command, not precede it.
- **Hold kinds mean:** `captain` awaits a human decision, `external` awaits something outside the fleet, `load` waits for capacity, `parked` is deliberately shelved, `future` is not yet due (pair with `--until`).
- **Never close a `captain` hold with a bare `done`.** Firstmate's `bin/fm-decision-hold.sh close <id>` is the safe path; a bare `done` can bury an unresolved decision in the retention archive where it is no longer addressable.

## Non-goals

- Not a `--help` replacement: flags, output schemas, and error codes come from the CLI itself.
- Not a general note store, and not a cross-home tracker; use `mv` for a deliberate cross-file move.
- Not a markdown editor: the backlog file stays hand-readable, but let the CLI do the writing so the round-trip stays byte-exact.
