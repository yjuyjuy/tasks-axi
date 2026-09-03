import { AxiError } from "../src/errors.js";
import type { LinearClientLike } from "../src/backends/linear-client.js";
import type { LinearIssueNode } from "../src/backends/linear-map.js";

/**
 * A fake Linear client for the backend and CLI tests.
 *
 * The backend is tested against this rather than the network: it models
 * Linear's response shapes, applies the same partition filter Linear applies
 * server-side, and records every request, which is what lets the tests assert
 * the batching, idempotence, and atomicity guarantees deterministically in CI.
 * Live verification against a real project is a separate, manual step - the
 * fake is necessary but never sufficient.
 */

export const TEAM = "DEV";
export const PROJECT = "Test Home";
/** A second home, for the cross-home `mv` tests. */
export const OTHER_PROJECT = "Other Home";

/** An `fm-meta` description carrying just the slug join key. */
export const meta = (slug: string): string => ["```fm-meta", `slug: ${slug}`, "```"].join("\n");

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

export class FakeLinear implements LinearClientLike {
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
      id: issue.id ?? `uuid-${issue.identifier}`,
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

  /**
   * The partition filter Linear would apply server-side: without it every home
   * would see every issue and a cross-home move would be untestable.
   */
  private projectOf(filter: unknown): string | undefined {
    const and = (filter as { and?: Record<string, never>[] } | undefined)?.and;
    for (const clause of and ?? []) {
      const name = (
        clause as { project?: { name?: { eqIgnoreCase?: string } } }
      ).project?.name?.eqIgnoreCase;
      if (name) return name;
    }
    return undefined;
  }

  /** Reverse of the id the fake mints in the resolve query. */
  private projectForId(projectId: string | undefined): string {
    if (!projectId) return PROJECT;
    const name = projectId.replace(/^proj-/, "").replace(/-/g, " ");
    return [PROJECT, OTHER_PROJECT].find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    ) ?? name;
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
      const project = this.projectOf(variables.filter);
      return {
        issues: {
          nodes: this.withRelations().filter(
            (issue) =>
              project === undefined || issue.project?.name === project,
          ),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      } as T;
    }
    if (query.includes("team(")) {
      const project = (variables.project as string) ?? PROJECT;
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
          projects: {
            nodes: [{ id: `proj-${project.replace(/\s+/g, "-")}`, name: project }],
          },
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
        project: { name: this.projectForId(input.projectId as string) },
      });
      return { issueCreate: { success: true, issue: node } } as T;
    }
    if (query.includes("issueBatchUpdate")) {
      const ids = variables.ids as string[];
      const input = variables.input as Record<string, string>;
      const moved = this.issues.filter((node) => ids.includes(node.id as string));
      if (moved.length !== ids.length) {
        throw new AxiError("unknown issue in batch", "NOT_FOUND");
      }
      // Linear applies a batch update to every issue or to none.
      for (const issue of moved) {
        if (input.projectId !== undefined) {
          issue.project = { name: this.projectForId(input.projectId) };
        }
        issue.updatedAt = new Date(Date.now() + ++this.seq).toISOString();
      }
      return {
        issueBatchUpdate: {
          success: true,
          issues: moved.map((issue) => ({ identifier: issue.identifier })),
        },
      } as T;
    }
    if (query.includes("issueUpdate")) {
      const id = variables.id as string;
      const input = variables.input as Record<string, string>;
      const issue = this.issues.find((node) => node.identifier === id);
      if (!issue) throw new AxiError("no such issue", "NOT_FOUND");
      if (input.title !== undefined) issue.title = input.title;
      if (input.description !== undefined) issue.description = input.description;
      if (input.labelIds !== undefined) {
        issue.labels = {
          nodes: labelNodes(input.labelIds as unknown as string[]),
        };
      }
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

