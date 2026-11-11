/**
 * An in-memory Linear for tests: answers the plugin's own GraphQL texts (matched by identity, from
 * queries.ts) the way Linear does. Every value is invented — no real workspace, team, person or key.
 */
import { LinearError, type Gql } from "./linear.js";
import * as Q from "./queries.js";
import type { WorkflowState } from "./queries.js";

export const FAKE_KEY = "fake-linear-key-for-tests-0123456789abcd";
export const WS = { id: "org-1", name: "Acme Test", urlKey: "acme-test" };
export const TEAM = { id: "team-1", key: "TST", name: "Throwaway" };

export interface FakeIssue {
  id: string; identifier: string; number: number; title: string; description: string;
  stateId: string; teamId: string; parentId: string | null; labelIds: string[];
  comments: { body: string; createdAt: string; user: { name: string; displayName: string } | null; botActor: { name: string } | null }[];
}

export const STATES: WorkflowState[] = [
  { id: "st-backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "st-doing", name: "In Progress", type: "started", position: 2 },
  { id: "st-done", name: "Done", type: "completed", position: 3 },
  { id: "st-dup", name: "Duplicate", type: "canceled", position: 5 },
  { id: "st-cancel", name: "Canceled", type: "canceled", position: 4 },
];

export function fakeLinear(opts: { key?: string } = {}) {
  const key = opts.key ?? FAKE_KEY;
  const issues = new Map<string, FakeIssue>();
  const labels: { id: string; name: string; team: { id: string } | null }[] = [{ id: "lab-ws", name: "Shared", team: null }];
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  let seq = 0;
  let failNext: LinearError | null = null;

  const find = (id: string) => issues.get(id) ?? [...issues.values()].find((i) => i.identifier === id) ?? null;
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  const node = (i: FakeIssue) => ({
    id: i.id, identifier: i.identifier, url: `https://linear.app/${WS.urlKey}/issue/${i.identifier}/${slug(i.title)}`,
    title: i.title, branchName: `tester/${i.identifier.toLowerCase()}-${slug(i.title)}`,
  });
  const stateType = (i: FakeIssue) => STATES.find((s) => s.id === i.stateId)!.type;
  const notFound = () => new LinearError("not_found", "Linear: Entity not found: Issue");

  const add = (o: Partial<FakeIssue> & { title: string }): FakeIssue => {
    const n = ++seq;
    const i: FakeIssue = {
      id: `uuid-${n}`, identifier: `${TEAM.key}-${n}`, number: n, description: "", stateId: "st-todo", teamId: TEAM.id,
      parentId: null, labelIds: [], comments: [], ...o,
    };
    issues.set(i.id, i);
    return i;
  };

  const gql: Gql = async <T>(k: string, query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ query, variables });
    if (k !== key) throw new LinearError("auth", "Linear rejected the key");
    if (failNext) { const f = failNext; failNext = null; throw f; }
    const v = variables as Record<string, any>;
    const out = ((): unknown => {
      switch (query) {
        case Q.VIEWER: return { viewer: { id: "user-1", name: "Test Person", organization: WS } };
        case Q.TEAMS: return { teams: { nodes: [TEAM, { id: "team-2", key: "OTH", name: "Other" }] } };
        case Q.TEAM: return { team: v.id === TEAM.id ? TEAM : null };
        case Q.TEAM_STATES: return { team: v.id === TEAM.id ? { id: TEAM.id, states: { nodes: STATES } } : null };
        case Q.LABELS: return { issueLabels: { nodes: labels.filter((l) => l.name.toLowerCase() === String(v.name).toLowerCase() && (!l.team || l.team.id === v.team)) } };
        case Q.LABEL_CREATE: {
          const l = { id: `lab-${labels.length + 1}`, name: v.input.name, team: { id: v.input.teamId } };
          labels.push(l);
          return { issueLabelCreate: { success: true, issueLabel: l } };
        }
        case Q.ISSUE_CREATE: {
          const { teamId, title, description, parentId, labelIds } = v.input;
          if (teamId !== TEAM.id) throw new LinearError("invalid", "Linear: Argument Validation Error");
          if (parentId && !find(parentId)) throw notFound();
          const i = add({ title, description: description ?? "", parentId: parentId ?? null, labelIds: labelIds ?? [] });
          return { issueCreate: { success: true, issue: node(i) } };
        }
        case Q.ISSUE_UPDATE: {
          const i = find(v.id);
          if (!i) throw notFound();
          const p = v.input;
          if ("title" in p) i.title = p.title;
          if ("description" in p) i.description = p.description;
          if ("stateId" in p) i.stateId = p.stateId;
          if ("parentId" in p) i.parentId = p.parentId;
          return { issueUpdate: { success: true, issue: node(i) } };
        }
        case Q.ISSUE_BRIEF: {
          const i = find(v.id);
          if (!i) throw notFound();
          return { issue: { ...node(i), state: { type: stateType(i) }, team: { id: i.teamId }, parent: i.parentId ? { id: i.parentId } : null } };
        }
        case Q.ISSUE_DETAIL: {
          const i = find(v.id);
          if (!i) throw notFound();
          return { issue: { ...node(i), description: i.description, state: { type: stateType(i) }, comments: { nodes: i.comments.slice(0, v.comments) } } };
        }
        case Q.CHILDREN: {
          const i = find(v.id);
          if (!i) throw notFound();
          return { issue: { id: i.id, children: { nodes: [...issues.values()].filter((c) => c.parentId === i.id).map(node) } } };
        }
        case Q.OPEN_ISSUES: {
          const f = v.filter;
          const nin: string[] = f.state.type.nin;
          const q: string | undefined = f.title?.containsIgnoreCase;
          const rows = [...issues.values()]
            .filter((i) => i.teamId === f.team.id.eq && !nin.includes(stateType(i)) && (!q || i.title.toLowerCase().includes(q.toLowerCase())))
            .reverse().slice(0, v.first);
          return { issues: { nodes: rows.map(node) } };
        }
        default: throw new Error(`fake Linear: unknown query ${query.slice(0, 40)}`);
      }
    })();
    return out as T;
  };

  return {
    gql, issues, labels, calls, add, find,
    queries: () => calls.map((c) => c.query.split(/[ ({]/)[1]),
    failNext: (e: LinearError) => { failNext = e; },
  };
}
