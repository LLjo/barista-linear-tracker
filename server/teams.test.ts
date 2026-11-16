/** Several teams per project (#1577): selection, default team, per-team states and labels. */
import { beforeEach, describe, expect, test } from "bun:test";
import { answerTracker, type TrackerAnswer, type TrackerLink, type TrackerOp } from "@barista/types/tracker";
import { FAKE_KEY, fakeLinear, STATES2, TEAM, TEAM2, TEAM3, WS } from "./fake-linear.js";
import { LinearError } from "./linear.js";
import { ALL_TEAMS, createHandlers, DEFAULT_OUTSIDE, scopeOf } from "./tracker.js";
import type { WorkspacePublic } from "./workspaces.js";

const project = { id: "p1", repoUrls: ["https://example.com/acme/app"], defaultBranch: "main" };
const CONFIG = { workspace: WS.id, team: TEAM.id };

let linear: ReturnType<typeof fakeLinear>;
let spaces: WorkspacePublic[];
let keys: Map<string, string>;
let clock: number;
let handlers: ReturnType<typeof createHandlers>;

const pub = (status: "ok" | "rejected" = "ok"): WorkspacePublic => ({
  id: WS.id, name: WS.name, urlKey: WS.urlKey, viewerName: "Test Person", keyLast4: FAKE_KEY.slice(-4),
  status, addedAt: "2026-01-01T00:00:00.000Z", checkedAt: null,
});

beforeEach(() => {
  linear = fakeLinear();
  spaces = [pub()];
  keys = new Map([[WS.id, FAKE_KEY]]);
  clock = 1_000_000;
  handlers = createHandlers({
    gql: linear.gql,
    workspaces: () => spaces,
    workspace: (id) => spaces.find((w) => w.id === id) ?? null,
    keyOf: (id) => keys.get(id) ?? null,
    setStatus: (id, status) => { spaces = spaces.map((w) => (w.id === id ? { ...w, status } : w)); },
    now: () => clock,
  });
});

/** One op through the contract's own answerer — what `barista.trackers.serve` runs. */
async function call<O extends TrackerOp>(op: O, args: Record<string, unknown> = {}, config: Record<string, string> = CONFIG): Promise<TrackerAnswer<O>> {
  return (await answerTracker(handlers, { op, project, config, ...args })) as TrackerAnswer<O>;
}
async function ok<O extends TrackerOp>(op: O, args: Record<string, unknown> = {}, config: Record<string, string> = CONFIG) {
  const a = await call(op, args, config);
  if (!a.ok) throw new Error(`${op} failed: ${a.code} ${a.error}`);
  return a;
}
const create = async (title: string, parent?: TrackerLink, kind: "epic" | "issue" = "issue") =>
  (await ok("create", { item: { kind, title, body: `${title} body`, number: 7 }, ...(parent ? { parent } : {}) })).link;

describe("several teams", () => {
  const TWO = { workspace: WS.id, teams: `${TEAM.id},${TEAM2.id}`, team: TEAM.id };
  const ALL = { workspace: WS.id, teams: ALL_TEAMS, team: TEAM.id };
  const item = (title: string) => ({ item: { kind: "issue", title, body: "" } });

  test("scope: blank teams = the default alone (a single-team project as saved before), * = all", () => {
    expect(scopeOf(CONFIG)).toEqual({ all: false, ids: [TEAM.id] });
    expect(scopeOf(TWO)).toEqual({ all: false, ids: [TEAM.id, TEAM2.id] });
    expect(scopeOf({ ...TWO, teams: ` ${TEAM2.id},, ${TEAM2.id} ` })).toEqual({ all: false, ids: [TEAM2.id] });
    expect(scopeOf({ ...TWO, teams: `${TEAM2.id},*` })).toEqual({ all: true });
  });

  test("new items go to the default team; import, list and close work from the other one with its own states", async () => {
    const a = (await ok("create", item("in default"), TWO)).link;
    expect(linear.find(a.id)!.teamId).toBe(TEAM.id);
    const b = linear.add({ title: "theirs", teamId: TEAM2.id });
    expect(await ok("resolveRef", { input: b.identifier }, TWO)).toMatchObject({ link: { id: b.id, ref: b.identifier }, title: "theirs" });
    expect((await ok("listOpen", {}, TWO)).issues.map((i) => i.ref)).toEqual([b.identifier, a.ref]);
    const filter = linear.calls.at(-1)!.variables.filter as { team: unknown };
    expect(filter.team).toEqual({ id: { in: [TEAM.id, TEAM2.id] } });
    await ok("close", { link: { id: b.id, ref: b.identifier, url: "" }, reason: "completed" }, TWO);
    expect(linear.find(b.id)!.stateId).toBe(STATES2.find((x) => x.type === "completed")!.id);
    await ok("reopen", { link: { id: b.id, ref: b.identifier, url: "" } }, TWO);
    expect(linear.find(b.id)!.stateId).toBe(STATES2.find((x) => x.type === "unstarted")!.id);
  });

  test("a ref from a team outside the selection is refused, naming the team and where to add it", async () => {
    const c = linear.add({ title: "elsewhere", teamId: TEAM3.id });
    for (const config of [TWO, { ...TWO, teams: TEAM.id }]) {
      const r = await call("resolveRef", { input: c.identifier }, config);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.code).toBe("not_found"); expect(r.error).toContain(TEAM3.key); expect(r.error).toContain("Settings › Project"); }
    }
    expect((await ok("listOpen", {}, TWO)).issues).toEqual([]);
  });

  test("a project that never picked teams adopts from any team, as before", async () => {
    const c = linear.add({ title: "elsewhere", teamId: TEAM3.id });
    expect((await ok("resolveRef", { input: c.identifier }, CONFIG)).link.id).toBe(c.id);
  });

  test("a default outside the selection files nothing", async () => {
    const r = await call("create", item("x"), { ...TWO, team: TEAM3.id });
    expect(r.ok ? null : [r.code, r.error]).toEqual(["unconfigured", DEFAULT_OUTSIDE]);
    expect(linear.issues.size).toBe(0);
  });

  test("a project narrowed to one team still files a sub-issue in its parent's team", async () => {
    const parent = linear.add({ title: "their epic", teamId: TEAM2.id });
    const link = (await ok("create", { item: { kind: "issue", title: "child", body: "" }, parent: { id: parent.id, ref: parent.identifier, url: "" } }, { ...TWO, teams: TEAM.id })).link;
    expect(linear.find(link.id)!.teamId).toBe(TEAM2.id);
  });

  test("All teams: any team's ref is adopted, and listOpen has no team filter", async () => {
    const c = linear.add({ title: "anywhere", teamId: TEAM3.id });
    expect((await ok("resolveRef", { input: c.identifier }, ALL)).link.id).toBe(c.id);
    expect((await ok("listOpen", {}, ALL)).issues.map((i) => i.id)).toEqual([c.id]);
    expect((linear.calls.at(-1)!.variables.filter as { team?: unknown }).team).toBeUndefined();
  });

  test("a sub-issue goes in its parent's team, labelled with that team's label", async () => {
    const parent = linear.add({ title: "their epic", teamId: TEAM2.id });
    const link = (await ok("create", { item: { kind: "issue", title: "child", body: "" }, parent: { id: parent.id, ref: parent.identifier, url: "" } }, { ...TWO, label: "barista" })).link;
    const child = linear.find(link.id)!;
    expect(child.teamId).toBe(TEAM2.id);
    expect(child.parentId).toBe(parent.id);
    expect(linear.labels.find((l) => l.id === child.labelIds[0])!.team).toEqual({ id: TEAM2.id });
  });

  test("Linear refusing a sub-issue in its parent's team says so", async () => {
    const parent = linear.add({ title: "their epic", teamId: TEAM2.id });
    const real = linear.gql;
    const h = createHandlers({
      gql: (async (k: string, q: string, v?: Record<string, unknown>) => {
        if (q.startsWith("mutation IssueCreate")) throw new LinearError("forbidden", "Linear: Forbidden");
        return real(k, q, v);
      }) as typeof linear.gql,
      workspaces: () => spaces, workspace: () => spaces[0]!, keyOf: () => FAKE_KEY, setStatus: () => {},
    });
    const a = await answerTracker(h, { op: "create", project, config: TWO, item: { kind: "issue", title: "c", body: "" }, parent: { id: parent.id, ref: parent.identifier, url: "" } });
    expect(a.ok).toBe(false);
    if (!a.ok) { expect(a.code).toBe("auth"); expect(a.error).toContain(`parent's team ${TEAM2.key}`); }
  });

  test("a single-team project asks nothing extra to file a sub-issue", async () => {
    const epic = await create("Epic");
    const before = linear.calls.length;
    await create("child", epic);
    expect(linear.queries().slice(before)).toEqual(["IssueCreate"]);
  });

  test("status: the default must be among the selected teams, and the key must see every one", async () => {
    expect(await ok("status", {}, { ...TWO, team: TEAM3.id })).toEqual({ ok: true, ready: false, why: DEFAULT_OUTSIDE });
    expect(await ok("status", {}, TWO)).toEqual({ ok: true, ready: true });
    expect(linear.queries().at(-1)).toBe("Teams");
    const gone = await ok("status", {}, { ...TWO, teams: `${TEAM.id},team-unknown` });
    expect(gone.ready).toBe(false);
    expect(gone.why).toContain("cannot see 1 of the selected teams");
    expect(await ok("status", {}, ALL)).toEqual({ ok: true, ready: true });
  });

  test("options: teams lead with All teams; the default is picked among the selected teams (any when none or all)", async () => {
    const teams = await ok("options", { field: "teams" }, { workspace: WS.id });
    expect(teams.options[0]).toEqual({ value: ALL_TEAMS, label: "All teams" });
    expect(teams.options.map((o) => o.value)).toEqual([ALL_TEAMS, TEAM.id, TEAM2.id, TEAM3.id]);
    const ids = async (config: Record<string, string>) => (await ok("options", { field: "team" }, config)).options.map((o) => o.value);
    expect(await ids(TWO)).toEqual([TEAM.id, TEAM2.id]);
    expect(await ids(ALL)).toEqual([TEAM.id, TEAM2.id, TEAM3.id]);
    expect(await ids({ workspace: WS.id })).toEqual([TEAM.id, TEAM2.id, TEAM3.id]);
  });
});
