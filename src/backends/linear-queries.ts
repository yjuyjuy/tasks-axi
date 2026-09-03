/**
 * Hand-written GraphQL documents for the linear backend.
 *
 * These are separate from `linear-axi`'s own documents on purpose: the CLI
 * there selects a compact row shape for display, while a backlog backend needs
 * the description (which carries the `fm-meta` block), the labels, and the
 * blocking edges for every issue in one round trip. Every connection passes an
 * explicit `first:`, matching the client's own rule.
 */

/** The per-issue selection the whole backend is built on. */
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  createdAt
  updatedAt
  state { name type }
  labels(first: 20) { nodes { id name } }
  project { name }
  inverseRelations(first: 50) { nodes { type issue { identifier } } }
`;

/**
 * The whole partition in one request: every issue in this home's project,
 * with everything needed to build a `Task`. One batched fetch per sync is what
 * makes a 20-id `show --full` loop cost a single network request.
 */
export const SNAPSHOT_QUERY = `query TasksAxiSnapshot($first: Int!, $filter: IssueFilter) {
  issues(first: $first, filter: $filter, orderBy: updatedAt) {
    nodes {${ISSUE_FIELDS}}
    pageInfo { hasNextPage endCursor }
  }
}`;

/** The same query, one page further in. */
export const SNAPSHOT_PAGE_QUERY = `query TasksAxiSnapshotPage($first: Int!, $after: String!, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes {${ISSUE_FIELDS}}
    pageInfo { hasNextPage endCursor }
  }
}`;

/**
 * The ids a write needs: the team, its workflow states (with types, never
 * names), its labels, and the home project.
 */
export const RESOLVE_QUERY = `query TasksAxiResolve($teamKey: String!, $project: String!, $first: Int!) {
  team(id: $teamKey) {
    id
    key
    states(first: $first) { nodes { id name type position } }
    labels(first: $first) { nodes { id name isGroup parent { name } } }
    projects(first: $first, filter: { name: { eqIgnoreCase: $project } }) {
      nodes { id name }
    }
  }
}`;

export const ISSUE_CREATE_MUTATION = `mutation TasksAxiCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {${ISSUE_FIELDS}}
  }
}`;

export const ISSUE_UPDATE_MUTATION = `mutation TasksAxiUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {${ISSUE_FIELDS}}
  }
}`;

/**
 * Linear has no delete verb by design, so `rm` archives. The archived issue
 * leaves the project view and stops appearing in any snapshot, which is what
 * both `rm` and `prune` need.
 */
export const ISSUE_ARCHIVE_MUTATION = `mutation TasksAxiArchive($id: String!) {
  issueArchive(id: $id) { success }
}`;

export const LABEL_CREATE_MUTATION = `mutation TasksAxiLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name parent { name } } }
}`;

export const RELATION_CREATE_MUTATION = `mutation TasksAxiRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success issueRelation { id } }
}`;

export const RELATION_DELETE_MUTATION = `mutation TasksAxiRelationDelete($id: String!) {
  issueRelationDelete(id: $id) { success }
}`;

/**
 * Reassign a whole set of issues in one request. `mv` moves a connected set
 * between homes, and a per-issue loop could fail halfway and strand a
 * dependency edge across two projects; `issueBatchUpdate` applies the change
 * to every issue server-side or to none, which is the atomicity the markdown
 * backend gets from a two-file lock. It addresses issues by UUID, not by the
 * `DEV-44` identifier, which is why `id` is part of the issue selection.
 */
export const ISSUE_BATCH_UPDATE_MUTATION = `mutation TasksAxiBatchUpdate($ids: [UUID!]!, $input: IssueUpdateInput!) {
  issueBatchUpdate(ids: $ids, input: $input) {
    success
    issues { identifier }
  }
}`;

/**
 * The blocking edges pointing at one issue, with each relation's own id:
 * `issueRelationDelete` takes the relation id, not the issue pair.
 */
export const BLOCKERS_QUERY = `query TasksAxiBlockers($id: String!, $first: Int!) {
  issue(id: $id) {
    identifier
    inverseRelations(first: $first) {
      nodes { id type issue { identifier } }
    }
  }
}`;
