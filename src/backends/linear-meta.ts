import { AxiError } from "../errors.js";
import { HOLD_KINDS, type Hold, type HoldKind, type Task } from "../model.js";
import {
  decodePublicFollowup,
  encodePublicFollowup,
  type PublicFollowup,
} from "../public-followup.js";

/**
 * The `fm-meta` block: the tasks-axi fields Linear has no column for.
 *
 * A Linear issue natively carries a title, a description, a state, a priority,
 * labels, and blocking relations. Everything else in the tasks-axi model -
 * `kind`, `resume`, structured holds, typed report/doc links, dependency
 * reasons, and the versioned public-followup record - has no home in the API,
 * so it rides in one fenced YAML-ish block at the top of the description.
 *
 * The block is deliberately a flat `key: value` list rather than real YAML: the
 * value set is small and bounded, every value is a single line, and parsing has
 * to be total (a human editing the description in Linear must never make an
 * issue unreadable). An unrecognized key is dropped rather than raising, and a
 * missing or malformed block simply yields no metadata, so an issue created by
 * hand in Linear's web UI is still a valid task.
 */

export const FM_META_FENCE = "```fm-meta";
const FENCE_END = "```";

export interface FmMeta {
  /**
   * The tasks-axi id. Ids are join keys to `state/<id>` and
   * `data/<id>/report.md` (decision D6), so the slug a caller supplied has to
   * survive even though Linear mints its own `DEV-44` identifier. An issue
   * created by hand in Linear has no slug and falls back to its identifier.
   */
  slug?: string;
  kind?: string;
  resume?: string;
  hold?: Hold;
  /** Typed non-PR links (report paths, doc urls) that prose scanning would lose. */
  links?: { kind: "report" | "doc"; url: string }[];
  /** Free-text reasons for blocking edges, keyed by the blocker's task id. */
  depReasons?: Record<string, string>;
  publicFollowup?: PublicFollowup;
  /** The tasks-axi `created` stamp, which Linear's `createdAt` cannot express. */
  created?: string;
}

/** Split a description into its `fm-meta` block and the human body below it. */
export function parseDescription(description: string | null): {
  meta: FmMeta;
  body: string | undefined;
} {
  const text = description ?? "";
  const lines = text.split("\n");
  if (lines[0]?.trim() !== FM_META_FENCE) {
    return { meta: {}, body: text.trim() === "" ? undefined : text.trim() };
  }
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FENCE_END,
  );
  if (end < 0) {
    // An unterminated fence is a hand-edit accident; treat the whole thing as
    // prose rather than swallowing the description.
    return { meta: {}, body: text.trim() === "" ? undefined : text.trim() };
  }
  const meta = parseMetaLines(lines.slice(1, end));
  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  return { meta, body: body === "" ? undefined : body };
}

function parseMetaLines(lines: string[]): FmMeta {
  const meta: FmMeta = {};
  let holdReason: string | undefined;
  let holdKind: HoldKind | undefined;
  let holdUntil: string | undefined;

  for (const line of lines) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, raw] = match;
    const value = unquote(raw);
    if (value === "") continue;
    switch (key) {
      case "slug":
        meta.slug = value;
        break;
      case "kind":
        meta.kind = value;
        break;
      case "resume":
        meta.resume = value;
        break;
      case "created":
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) meta.created = value;
        break;
      case "hold":
        holdReason = value;
        break;
      case "hold_kind":
        if ((HOLD_KINDS as readonly string[]).includes(value)) {
          holdKind = value as HoldKind;
        }
        break;
      case "hold_until":
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) holdUntil = value;
        break;
      case "report":
        meta.links = [...(meta.links ?? []), { kind: "report", url: value }];
        break;
      case "doc":
        meta.links = [...(meta.links ?? []), { kind: "doc", url: value }];
        break;
      case "dep_reason": {
        // `dep_reason: <blocker-id> - <reason>`: one line per edge, so a
        // reason never has to be escaped or nested.
        const edge = /^(\S+)\s+-\s+(.+)$/.exec(value);
        if (edge) {
          meta.depReasons = { ...meta.depReasons, [edge[1]]: edge[2] };
        }
        break;
      }
      case "public_followup":
        meta.publicFollowup = decodePublicFollowup(value);
        break;
      default:
        break;
    }
  }

  if (holdReason !== undefined) {
    meta.hold = {
      reason: holdReason,
      ...(holdKind !== undefined ? { kind: holdKind } : {}),
      ...(holdUntil !== undefined ? { until: holdUntil } : {}),
    };
  }
  return meta;
}

/**
 * Render a task's description: the `fm-meta` block, then the human body.
 *
 * The block always carries at least the slug, because the id is the join key
 * every other firstmate artifact is addressed by and losing it would orphan
 * `state/<id>` and `data/<id>/report.md`.
 */
export function renderDescription(task: Task): string {
  const lines: string[] = [`slug: ${quote(task.id)}`];
  if (task.kind) lines.push(`kind: ${quote(task.kind)}`);
  if (task.created) lines.push(`created: ${task.created}`);
  if (task.resume) lines.push(`resume: ${quote(task.resume)}`);
  if (task.hold) {
    lines.push(`hold: ${quote(task.hold.reason)}`);
    if (task.hold.kind) lines.push(`hold_kind: ${task.hold.kind}`);
    if (task.hold.until) lines.push(`hold_until: ${task.hold.until}`);
  }
  for (const link of task.links) {
    // PR links are re-derived from the prose exactly as the markdown backend
    // does, so only the kinds prose scanning cannot recover are recorded.
    if (link.kind === "report" || link.kind === "doc") {
      lines.push(`${link.kind}: ${quote(link.url)}`);
    }
  }
  for (const dep of task.deps) {
    if (dep.reason) lines.push(`dep_reason: ${dep.id} - ${quote(dep.reason)}`);
  }
  if (task.public_followup) {
    lines.push(`public_followup: ${encodePublicFollowup(task.public_followup)}`);
  }

  const body = task.body?.trim() ?? "";
  const block = [FM_META_FENCE, ...lines, FENCE_END].join("\n");
  return body === "" ? block : `${block}\n\n${body}`;
}

/**
 * Values are single-line by construction everywhere upstream, but a hand-edited
 * description can still contain a newline; refuse rather than emit a block that
 * would parse back differently.
 */
function quote(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new AxiError(
      "fm-meta values must be single-line",
      "VALIDATION_ERROR",
    );
  }
  return value;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    (trimmed.startsWith('"') || trimmed.startsWith("'")) &&
    trimmed.endsWith(trimmed[0])
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
