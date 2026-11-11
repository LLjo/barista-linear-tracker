/**
 * Every GraphQL text this plugin sends to Linear. Pure. `queries.test.ts` checks them against Linear's
 * live schema when LINEAR_SCHEMA_CHECK=1 (Linear validates a query before it checks auth, so an
 * unauthenticated request that answers AUTHENTICATION_ERROR means the text is valid).
 */

const ISSUE = "id identifier url title branchName";

export const VIEWER = `query Viewer { viewer { id name organization { id name urlKey } } }`;

export const TEAMS = `query Teams { teams(first: 100) { nodes { id key name } } }`;

export const TEAM = `query Team($id: String!) { team(id: $id) { id key name } }`;

export const TEAM_STATES = `query TeamStates($id: String!) {
  team(id: $id) { id states(first: 100) { nodes { id name type position } } }
}`;

export const LABELS = `query Labels($name: String!) {
  issueLabels(first: 50, filter: { name: { eqIgnoreCase: $name } }) { nodes { id name team { id } } }
}`;

export const LABEL_CREATE = `mutation LabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name } }
}`;

export const ISSUE_CREATE = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE} } }
}`;

export const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${ISSUE} } }
}`;

/** One issue by uuid or identifier (`STA-42`): what every lifecycle op needs to decide. */
export const ISSUE_BRIEF = `query IssueBrief($id: String!) {
  issue(id: $id) { ${ISSUE} state { type } team { id } parent { id } }
}`;

export const ISSUE_DETAIL = `query IssueDetail($id: String!, $comments: Int!) {
  issue(id: $id) {
    ${ISSUE} description state { type }
    comments(first: $comments) { nodes { body createdAt user { name displayName } botActor { name } } }
  }
}`;

export const CHILDREN = `query Children($id: String!) {
  issue(id: $id) { id children(first: 100) { nodes { ${ISSUE} } } }
}`;

export const OPEN_ISSUES = `query OpenIssues($first: Int!, $filter: IssueFilter!) {
  issues(first: $first, orderBy: updatedAt, filter: $filter) { nodes { ${ISSUE} } }
}`;

export const ALL = [VIEWER, TEAMS, TEAM, TEAM_STATES, LABELS, LABEL_CREATE, ISSUE_CREATE, ISSUE_UPDATE, ISSUE_BRIEF, ISSUE_DETAIL, CHILDREN, OPEN_ISSUES];

// ── Answer shapes ────────────────────────────────────────────────────

export interface IssueNode { id: string; identifier: string; url: string; title: string; branchName: string }
export type StateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | string;
export interface WorkflowState { id: string; name: string; type: StateType; position: number }
export interface Viewer { viewer: { id: string; name: string; organization: { id: string; name: string; urlKey: string } } }
