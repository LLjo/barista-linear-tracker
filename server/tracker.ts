/**
 * The tracker ops (#1541 design §1.4, §4): Barista items become Linear issues in the project's default team
 * (`team`), within the teams it selected (`teams`: team ids joined by ",", "*" = every team, blank = only the
 * default team, which is what a project set up before multi-team selection has). Epics
 * become parent issues, sub-issues are Linear children (`parentId`). Built from injected deps so tests run
 * without a database or a network. Every answer is either the op's data or a `TrackerFailure` whose
 * sentence names where to fix it — and none of them ever carries the key.
 */
import { trackerFail, type TrackerFailure, type TrackerHandlers, type TrackerIssueRow, type TrackerLink } from "@barista/types/tracker";
import { LinearError, type Gql } from "./linear.js";
import {
  CHILDREN, ISSUE_BRIEF, ISSUE_CREATE, ISSUE_DETAIL, ISSUE_UPDATE, LABEL_CREATE, LABELS, OPEN_ISSUES, TEAM, TEAM_STATES, TEAMS,
  type IssueNode, type StateType, type WorkflowState,
} from "./queries.js";
import type { WorkspacePublic } from "./workspaces.js";

export const SETTINGS_KEY = "linear-tracker";
/** Team workflow states and label ids are looked up at most this often (design §4 "Rate limit"). */
export const CACHE_MS = 10 * 60_000;
/** `status` checks the key against the team at most this often per workspace + team. */
export const STATUS_CACHE_MS = 60_000;
export const LIST_MAX = 50;
export const COMMENTS_MAX = 50;
/** One op's whole budget across its Linear requests: under the board's 15 s call timeout, so a slow Linear
 *  fails the op here rather than leaving the board to give up while a write still lands. */
export const OP_BUDGET_MS = 11_000;

export interface TrackerDeps {
  gql: Gql;
  workspaces(): WorkspacePublic[];
  workspace(id: string): WorkspacePublic | null;
  /** The only way to a key (keys.ts). */
  keyOf(id: string): string | null;
  setStatus(id: string, status: "ok" | "rejected"): void;
  now?(): number;
}

export const NO_KEY = "Add a Linear API key with write access in Settings › Linear.";
export const PICK = "Pick this project's Linear workspace and team in Settings › Project.";
export const PICK_TEAM = "Pick this project's Linear team in Settings › Project.";
export const DEFAULT_OUTSIDE = "The default team is not one of the selected teams. Pick a default among them in Settings › Project.";
/** The `teams` value meaning every team the key can see. */
export const ALL_TEAMS = "*";
const rejected = (w: WorkspacePublic) => `Linear rejected the key for ${w.name}. Paste a new one in Settings › Linear.`;

const CLOSED: ReadonlySet<StateType> = new Set(["completed", "canceled"]);

/** The teams a project works in: every team, or these ids (the default team among them). */
export type Scope = { all: true } | { all: false; ids: string[] };

/** `teams` as saved (ids joined by ","; "*" = all) with the default team: blank `teams` = the default alone. */
export function scopeOf(config: Record<string, string>): Scope {
  const picked = [...new Set((config.teams ?? "").split(",").map((x) => x.trim()).filter(Boolean))];
  if (picked.includes(ALL_TEAMS)) return { all: true };
  const team = config.team?.trim();
  return { all: false, ids: picked.length ? picked : team ? [team] : [] };
}
const inScope = (s: Scope, teamId: string) => s.all || s.ids.includes(teamId);

interface Ctx {
  ws: WorkspacePublic; team: string | null; label: string | null; scope: Scope;
  /** A request to Linear with the workspace's key, within what is left of the op's budget. */
  q<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** Did Linear answer any request of this op? (Only then may a "rejected" mark be lifted.) */
  reached: boolean;
}
type Brief = IssueNode & { state: { type: StateType } | null; team: { id: string; key: string } | null; parent: { id: string } | null };

const linkOf = (n: IssueNode): TrackerLink => ({ id: n.id, ref: n.identifier, url: n.url });
const rowOf = (n: IssueNode): TrackerIssueRow => ({ ...linkOf(n), title: n.title });
const isFail = (x: unknown): x is TrackerFailure => !!x && typeof x === "object" && (x as { ok?: unknown }).ok === false;

/** `STA-42`, or a `linear.app/<workspace>/issue/STA-42/…` link. null = neither. */
export function parseRef(input: string): { identifier: string; urlKey?: string } | null {
  const t = input.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?linear\.app\/([^/\s]+)\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#]\S*)?$/i.exec(t);
  if (url) return { identifier: url[2]!.toUpperCase(), urlKey: url[1]!.toLowerCase() };
  const id = /^([A-Za-z][A-Za-z0-9_]*-\d+)$/.exec(t);
  return id ? { identifier: id[1]!.toUpperCase() } : null;
}

export function createHandlers(d: TrackerDeps): TrackerHandlers {
  const now = d.now ?? Date.now;
  const states = new Map<string, { at: number; nodes: WorkflowState[] }>();
  const labels = new Map<string, { at: number; id: string }>();
  const checked = new Map<string, { at: number; answer: { ready: boolean; why?: string; settingsKey?: string } }>();

  /** The project's workspace, its key, and its team/label — or the sentence saying what to set. */
  function ctxOf(config: Record<string, string>, needTeam: boolean): Ctx | TrackerFailure {
    const wsId = config.workspace?.trim();
    if (!wsId) return trackerFail("unconfigured", d.workspaces().length ? PICK : NO_KEY);
    const ws = d.workspace(wsId);
    const key = ws ? d.keyOf(ws.id) : null;
    if (!ws || !key) return trackerFail("unconfigured", `This project's Linear workspace has no key. ${NO_KEY}`);
    const team = config.team?.trim() || null;
    if (needTeam && !team) return trackerFail("unconfigured", PICK_TEAM);
    const started = Date.now();
    const ctx: Ctx = {
      ws, team, label: config.label?.trim() || null, scope: scopeOf(config), reached: false,
      q: async <T>(query: string, variables: Record<string, unknown> = {}) => {
        const left = OP_BUDGET_MS - (Date.now() - started);
        if (left < 500) throw new LinearError("network", "Linear did not answer in time");
        const out = await d.gql<T>(key, query, variables, left);
        ctx.reached = true;
        return out;
      },
    };
    return ctx;
  }

  /** Run `fn` with the project's context; a Linear failure becomes the contract's failure. */
  async function withCtx<T>(config: Record<string, string>, needTeam: boolean, fn: (c: Ctx) => Promise<T | TrackerFailure>): Promise<T | TrackerFailure> {
    const c = ctxOf(config, needTeam);
    if (isFail(c)) return c;
    try {
      const out = await fn(c);
      if (c.reached && c.ws.status === "rejected") d.setStatus(c.ws.id, "ok");
      return out;
    } catch (e) {
      return failure(e, c.ws);
    }
  }

  function failure(e: unknown, ws: WorkspacePublic): TrackerFailure {
    if (!(e instanceof LinearError)) return trackerFail("unavailable", "The Linear tracker failed unexpectedly");
    switch (e.kind) {
      case "auth":
        d.setStatus(ws.id, "rejected");
        return trackerFail("auth", rejected(ws));
      case "forbidden": return trackerFail("auth", `${e.message}. The key for ${ws.name} needs write access to this team.`);
      case "rate": return trackerFail("rate_limited", e.message);
      case "not_found": return trackerFail("not_found", e.message);
      case "invalid": return trackerFail("invalid", e.message);
      default: return trackerFail("unavailable", e.message);
    }
  }

  const brief = async (c: Ctx, id: string): Promise<Brief> => {
    const { issue } = await c.q<{ issue: Brief | null }>(ISSUE_BRIEF, { id });
    if (!issue) throw new LinearError("not_found", "Linear has no such issue");
    return issue;
  };

  async function teamStates(c: Ctx, teamId: string): Promise<WorkflowState[]> {
    const hit = states.get(teamId);
    if (hit && now() - hit.at < CACHE_MS) return hit.nodes;
    const { team } = await c.q<{ team: { states: { nodes: WorkflowState[] } } | null }>(TEAM_STATES, { id: teamId });
    const nodes = [...(team?.states.nodes ?? [])].sort((a, b) => a.position - b.position);
    if (nodes.length) states.set(teamId, { at: now(), nodes });
    return nodes;
  }

  /** The team's first state of one of `types` (in that order of preference). */
  async function stateOf(c: Ctx, teamId: string, types: StateType[]): Promise<WorkflowState> {
    const nodes = await teamStates(c, teamId);
    for (const t of types) {
      const s = nodes.find((n) => n.type === t);
      if (s) return s;
    }
    throw new LinearError("invalid", `The Linear team has no "${types[0]}" workflow state`);
  }

  async function labelId(c: Ctx, teamId: string, name: string): Promise<string> {
    const k = `${teamId}\n${name.toLowerCase()}`;
    const hit = labels.get(k);
    if (hit && now() - hit.at < CACHE_MS) return hit.id;
    const { issueLabels } = await c.q<{ issueLabels: { nodes: { id: string; team: { id: string } | null }[] } }>(LABELS, { name, team: teamId });
    const found = issueLabels.nodes.find((l) => l.team?.id === teamId) ?? issueLabels.nodes.find((l) => !l.team);
    let id = found?.id;
    if (!id) {
      const r = await c.q<{ issueLabelCreate: { success: boolean; issueLabel: { id: string } | null } }>(LABEL_CREATE, { input: { name, teamId } });
      if (!r.issueLabelCreate.success || !r.issueLabelCreate.issueLabel) throw new LinearError("invalid", `Linear did not create the label "${name}"`);
      id = r.issueLabelCreate.issueLabel.id;
    }
    labels.set(k, { at: now(), id });
    return id;
  }

  const update = async (c: Ctx, id: string, input: Record<string, unknown>): Promise<IssueNode> => {
    const r = await c.q<{ issueUpdate: { success: boolean; issue: IssueNode | null } }>(ISSUE_UPDATE, { id, input });
    if (!r.issueUpdate.success || !r.issueUpdate.issue) throw new LinearError("invalid", "Linear did not update the issue");
    return r.issueUpdate.issue;
  };

  return {
    status: async ({ config }) => {
      if (!d.workspaces().length) return { ready: false, why: NO_KEY, settingsKey: SETTINGS_KEY };
      const c = ctxOf(config, true);
      if (isFail(c)) return { ready: false, why: c.error, ...(c.error === PICK || c.error === PICK_TEAM ? {} : { settingsKey: SETTINGS_KEY }) };
      if (!inScope(c.scope, c.team!)) return { ready: false, why: DEFAULT_OUTSIDE };
      const others = c.scope.all ? [] : c.scope.ids.filter((id) => id !== c.team);
      const k = `${c.ws.id}\n${c.team}\n${others.join(",")}\n${c.ws.keyLast4}`; // a new key is checked afresh
      const hit = checked.get(k);
      if (hit && now() - hit.at < STATUS_CACHE_MS && c.ws.status === "ok") return hit.answer;
      let answer: { ready: boolean; why?: string; settingsKey?: string };
      try {
        let seen: boolean;
        if (!others.length) {
          const { team } = await c.q<{ team: { id: string } | null }>(TEAM, { id: c.team });
          seen = !!team;
        } else {
          // Several teams: one list of every team the key sees, rather than a request per team.
          const { teams } = await c.q<{ teams: { nodes: { id: string }[] } }>(TEAMS);
          const ids = new Set(teams.nodes.map((t) => t.id));
          seen = [c.team!, ...others].every((id) => ids.has(id));
        }
        answer = seen ? { ready: true } : { ready: false, why: `The key for ${c.ws.name} cannot see ${others.length ? "every selected team" : "this project's team"}. ${PICK_TEAM}` };
        if (c.ws.status === "rejected") d.setStatus(c.ws.id, "ok");
      } catch (e) {
        const f = failure(e, c.ws);
        answer = f.code === "not_found"
          ? { ready: false, why: `The key for ${c.ws.name} cannot see this project's team. ${PICK_TEAM}` }
          : { ready: false, why: f.error, ...(f.code === "auth" ? { settingsKey: SETTINGS_KEY } : {}) };
        if (f.code !== "auth" && f.code !== "not_found") return answer; // transient: not cached
      }
      checked.set(k, { at: now(), answer });
      return answer;
    },

    options: async ({ config, field }) => {
      if (field === "workspace") return { options: d.workspaces().map((w) => ({ value: w.id, label: w.name })) };
      if (field !== "team" && field !== "teams") return trackerFail("invalid", `The Linear tracker has no field "${field}"`);
      return withCtx(config, false, async (c) => {
        const { teams } = await c.q<{ teams: { nodes: { id: string; key: string; name: string }[] } }>(TEAMS);
        const all = teams.nodes.map((t) => ({ value: t.id, label: `${t.name} (${t.key})` }));
        if (field === "teams") return { options: [{ value: ALL_TEAMS, label: "All teams" }, ...all] };
        // The default team is one of the selected teams; with none selected (or all), any team.
        const picked = (config.teams ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        const s = scopeOf(config);
        return { options: s.all || !picked.length ? all : all.filter((o) => inScope(s, o.value)) };
      });
    },

    create: async ({ config, item, parent }) =>
      withCtx(config, true, async (c) => {
        // A sub-issue goes in its parent's team (Linear files children in their parent's team); else the default team.
        let teamId = c.team!, parentKey: string | null = null;
        // A single-team project's parents are all in that team: no request to ask.
        const single = !c.scope.all && c.scope.ids.length === 1 && c.scope.ids[0] === teamId;
        if (parent && !single) {
          const p = await brief(c, parent.id);
          if (p.team && p.team.id !== teamId) { teamId = p.team.id; parentKey = p.team.key; }
        }
        const input: Record<string, unknown> = { teamId, title: item.title, description: item.body };
        if (parent) input.parentId = parent.id;
        if (c.label) input.labelIds = [await labelId(c, teamId, c.label)];
        let r: { issueCreate: { success: boolean; issue: IssueNode | null } };
        try {
          r = await c.q(ISSUE_CREATE, { input });
        } catch (e) {
          if (parentKey && e instanceof LinearError && (e.kind === "invalid" || e.kind === "forbidden")) {
            throw new LinearError(e.kind, `Linear refused the sub-issue in its parent's team ${parentKey} (${e.message}). The key needs write access to ${parentKey}`);
          }
          throw e;
        }
        if (!r.issueCreate.success || !r.issueCreate.issue) throw new LinearError("invalid", "Linear did not create the issue");
        return { link: linkOf(r.issueCreate.issue) };
      }),

    update: async ({ config, link, patch }) =>
      withCtx(config, false, async (c) => {
        const input: Record<string, unknown> = {};
        if (typeof patch.title === "string") input.title = patch.title;
        if (typeof patch.body === "string") input.description = patch.body;
        if (Object.keys(input).length) await update(c, link.id, input);
        return {};
      }),

    close: async ({ config, link, reason }) =>
      withCtx(config, false, async (c) => {
        const b = await brief(c, link.id);
        if (b.state && CLOSED.has(b.state.type)) return {};
        if (!b.team) throw new LinearError("invalid", "Linear did not say which team the issue is in");
        const s = await stateOf(c, b.team.id, reason === "not_planned" ? ["canceled"] : ["completed"]);
        await update(c, b.id, { stateId: s.id });
        return {};
      }),

    reopen: async ({ config, link }) =>
      withCtx(config, false, async (c) => {
        const b = await brief(c, link.id);
        if (!b.state || !CLOSED.has(b.state.type)) return {};
        if (!b.team) throw new LinearError("invalid", "Linear did not say which team the issue is in");
        const s = await stateOf(c, b.team.id, ["unstarted", "backlog", "started"]);
        await update(c, b.id, { stateId: s.id });
        return {};
      }),

    link: async ({ config, parent, child }) =>
      withCtx(config, false, async (c) => {
        const b = await brief(c, child.id);
        if (b.parent?.id === parent.id) return { already: true };
        await update(c, b.id, { parentId: parent.id });
        return {};
      }),

    unlink: async ({ config, parent, child }) =>
      withCtx(config, false, async (c) => {
        let b: Brief;
        try {
          b = await brief(c, child.id);
        } catch (e) {
          if (e instanceof LinearError && e.kind === "not_found") return { already: true };
          throw e;
        }
        if (b.parent?.id !== parent.id) return { already: true };
        await update(c, b.id, { parentId: null });
        return {};
      }),

    listChildren: async ({ config, parent }) =>
      withCtx(config, false, async (c) => {
        const { issue } = await c.q<{ issue: { children: { nodes: IssueNode[] } } | null }>(CHILDREN, { id: parent.id });
        return { children: (issue?.children.nodes ?? []).map(rowOf) };
      }),

    getIssue: async ({ config, link, comments }) =>
      withCtx(config, false, async (c) => {
        type Comment = { body: string; createdAt: string; user: { name: string; displayName: string } | null; botActor: { name: string | null } | null };
        const { issue } = await c.q<{ issue: (IssueNode & { description: string | null; state: { type: StateType } | null; comments: { nodes: Comment[] } }) | null }>(
          ISSUE_DETAIL, { id: link.id, comments: COMMENTS_MAX },
        );
        if (!issue) throw new LinearError("not_found", "Linear has no such issue");
        const out: { title: string; body: string; state: "open" | "closed"; comments?: { author: string; body: string }[] } = {
          title: issue.title, body: issue.description ?? "", state: issue.state && CLOSED.has(issue.state.type) ? "closed" : "open",
        };
        if (comments) {
          out.comments = [...issue.comments.nodes]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((n) => ({ author: n.user?.displayName || n.user?.name || n.botActor?.name || "Linear", body: n.body }));
        }
        return out;
      }),

    resolveRef: async ({ config, input }) =>
      withCtx(config, false, async (c) => {
        const ref = parseRef(input);
        // The input is not repeated back: whatever was pasted (a key, by mistake) stays out of the answer.
        if (!ref) return trackerFail("not_found", "That is not a Linear issue (like STA-42) or a linear.app issue link — nothing to adopt.");
        if (ref.urlKey && ref.urlKey !== c.ws.urlKey.toLowerCase()) {
          return trackerFail("not_found", `${ref.identifier} is in the Linear workspace "${ref.urlKey}", not this project's (${c.ws.urlKey}) — nothing to adopt.`);
        }
        try {
          const b = await brief(c, ref.identifier);
          if (b.team && !inScope(c.scope, b.team.id)) {
            return trackerFail("not_found", `${ref.identifier} is in the Linear team ${b.team.key}, which this project has not selected. Add it in Settings › Project — nothing adopted.`);
          }
          return { link: linkOf(b), title: b.title };
        } catch (e) {
          if (e instanceof LinearError && e.kind === "not_found") return trackerFail("not_found", `${ref.identifier} is not an issue in ${c.ws.name} — nothing to adopt.`);
          throw e;
        }
      }),

    listOpen: async ({ config, query, limit }) =>
      withCtx(config, true, async (c) => {
        const filter: Record<string, unknown> = { state: { type: { nin: [...CLOSED] } } };
        if (!c.scope.all) filter.team = c.scope.ids.length === 1 ? { id: { eq: c.scope.ids[0] } } : { id: { in: c.scope.ids } };
        const q = typeof query === "string" ? query.trim() : "";
        if (q) filter.title = { containsIgnoreCase: q };
        const first = Math.max(1, Math.min(LIST_MAX, Number.isInteger(limit) && limit! > 0 ? limit! : LIST_MAX));
        const { issues } = await c.q<{ issues: { nodes: IssueNode[] } }>(OPEN_ISSUES, { first, filter });
        return { issues: issues.nodes.map(rowOf) };
      }),

    suggestBranch: async ({ config, link }) =>
      withCtx(config, false, async (c) => {
        const b = await brief(c, link.id);
        const name = typeof b.branchName === "string" ? b.branchName.trim() : "";
        return { branch: name || null };
      }),
  };
}
