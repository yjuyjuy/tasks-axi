import { readFileSafe } from "./lock.js";
import { atomicWrite } from "./lock.js";
import type { LinearIssueNode } from "./linear-map.js";

/**
 * The on-disk snapshot cache.
 *
 * Caching is a correctness requirement here, not an optimization (ticket
 * DEV-44 acceptance criterion 3): a `show --full` loop over 20 ids issues 20
 * separate CLI invocations, each a fresh process, so an in-memory cache would
 * buy nothing. The whole partition is fetched in one batched request and
 * written to disk; a subsequent process inside the TTL serves that file and
 * makes no network request at all.
 *
 * `updatedAt` is what keys the cache: the snapshot records the newest
 * `updatedAt` across the partition, so a revalidation can tell "nothing
 * changed" from "something changed" without trusting a wall-clock TTL alone.
 */

export const CACHE_VERSION = 1;

export interface Snapshot {
  version: number;
  /** Epoch millis the snapshot was fetched. */
  fetchedAt: number;
  /** Team key + project name the snapshot covers; a config change invalidates it. */
  team: string;
  project: string;
  /** The newest `updatedAt` across the partition, the cache's real key. */
  updatedAt: string;
  issues: LinearIssueNode[];
}

export function newestUpdatedAt(issues: LinearIssueNode[]): string {
  let newest = "";
  for (const issue of issues) {
    if (issue.updatedAt > newest) newest = issue.updatedAt;
  }
  return newest;
}

export function readSnapshot(path: string): Snapshot | undefined {
  const raw = readFileSafe(path);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt cache is never fatal: it is derived data, so a bad file just
    // means the next read goes to the network.
    return undefined;
  }
  const snapshot = parsed as Partial<Snapshot>;
  if (
    snapshot.version !== CACHE_VERSION ||
    typeof snapshot.fetchedAt !== "number" ||
    !Array.isArray(snapshot.issues)
  ) {
    return undefined;
  }
  return snapshot as Snapshot;
}

export function writeSnapshot(path: string, snapshot: Snapshot): void {
  atomicWrite(path, `${JSON.stringify(snapshot)}\n`);
}

/** True while the snapshot may be served without contacting Linear at all. */
export function isFresh(
  snapshot: Snapshot,
  ttlSeconds: number,
  now: number,
  team: string,
  project: string,
): boolean {
  if (snapshot.team !== team || snapshot.project !== project) return false;
  const age = now - snapshot.fetchedAt;
  return age >= 0 && age < ttlSeconds * 1000;
}
