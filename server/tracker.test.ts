import { beforeEach, describe, expect, test } from "bun:test";
import { answerTracker, type TrackerAnswer, type TrackerLink, type TrackerOp } from "@barista/types/tracker";
import { FAKE_KEY, fakeLinear, TEAM, WS } from "./fake-linear.js";
import { LinearError } from "./linear.js";
import { CACHE_MS, createHandlers, NO_KEY, OP_BUDGET_MS, parseRef, PICK, PICK_TEAM, SETTINGS_KEY } from "./tracker.js";
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

describe("create", () => {
  test("files an issue in the project's team: STA-n ref, uuid id, Linear url", async () => {
    const link = await create("Fix the login");
    expect(link).toEqual({ id: "uuid-1", ref: "TST-1", url: "https://linear.app/acme-test/issue/TST-1/fix-the-login" });
    const i = linear.find("uuid-1")!;
    expect(i.teamId).toBe(TEAM.id);
    expect(i.description).toBe("Fix the login body");
    expect(link.number).toBeUndefined(); // numbering:"barista"
  });

  test("an epic is a parent issue with its title as is, and its children are Linear children", async () => {
    const epic = await create("Payments revamp", undefined, "epic");
    expect(linear.find(epic.id)!.title).toBe("Payments revamp");
    const a = await create("Card form", epic);
    const b = await create("Refunds", epic);
    expect(linear.find(a.id)!.parentId).toBe(epic.id);
    const kids = await ok("listChildren", { parent: epic });
    expect(kids.children.map((c) => c.ref).sort()).toEqual([a.ref, b.ref].sort());
    expect(kids.children[0]!.title).toBeString();
  });

  test("the project's label is found (team or workspace) or created once, then reused", async () => {
    await ok("create", { item: { kind: "issue", title: "A", body: "" } }, { ...CONFIG, label: "shared" });
    expect(linear.find("TST-1")!.labelIds).toEqual(["lab-ws"]);
    await ok("create", { item: { kind: "issue", title: "B", body: "" } }, { ...CONFIG, label: "barista" });
    await ok("create", { item: { kind: "issue", title: "C", body: "" } }, { ...CONFIG, label: "Barista" });
    expect(linear.labels.filter((l) => l.name === "barista")).toHaveLength(1);
    expect(linear.find("TST-3")!.labelIds).toEqual(linear.find("TST-2")!.labelIds);
    expect(linear.queries().filter((q) => q === "LabelCreate")).toHaveLength(1);
  });

  test("without a team it is unconfigured, with where to set it", async () => {
    const a = await call("create", { item: { kind: "issue", title: "x", body: "" } }, { workspace: WS.id });
    expect(a).toEqual({ ok: false, code: "unconfigured", error: PICK_TEAM });
    expect(linear.calls).toHaveLength(0);
  });
});

describe("branch names", () => {
  test("suggestBranch answers Linear's own branchName, epics included", async () => {
    const epic = await create("Payments revamp", undefined, "epic");
    const a = await ok("suggestBranch", { link: epic, item: { kind: "epic", title: "Payments revamp", number: 3 } });
    expect(a.branch).toBe("tester/tst-1-payments-revamp");
  });
  test("an empty branchName answers null (the board's own name is used)", async () => {
    await create("x");
    const real = linear.gql;
    const handlers2 = createHandlers({
      gql: (async (k: string, q: string, v?: Record<string, unknown>) => {
        const r = (await real(k, q, v)) as { issue?: { branchName?: string } };
        if (r.issue) r.issue.branchName = "";
        return r;
      }) as typeof real,
      workspaces: () => spaces, workspace: () => spaces[0]!, keyOf: () => FAKE_KEY, setStatus: () => {},
    });
    const a = await answerTracker(handlers2, { op: "suggestBranch", project, config: CONFIG, link: { id: "uuid-1", ref: "TST-1", url: "" }, item: { kind: "issue", title: "x", number: 1 } });
    expect(a).toEqual({ ok: true, branch: null });
  });
});

describe("close / reopen", () => {
  test("close completed → the team's first completed state; again is a no-op ok", async () => {
    const link = await create("Ship it");
    await ok("close", { link, reason: "completed" });
    expect(linear.find(link.id)!.stateId).toBe("st-done");
    const before = linear.calls.length;
    await ok("close", { link, reason: "completed" });
    expect(linear.calls.slice(before).map((c) => c.query.includes("mutation"))).toEqual([false]); // read only
  });

  test("close not_planned → the first canceled state by position", async () => {
    const link = await create("Drop it");
    await ok("close", { link, reason: "not_planned" });
    expect(linear.find(link.id)!.stateId).toBe("st-cancel");
  });

  test("a closed issue is not moved by a second close with another reason", async () => {
    const link = await create("x");
    await ok("close", { link, reason: "completed" });
    await ok("close", { link, reason: "not_planned" });
    expect(linear.find(link.id)!.stateId).toBe("st-done");
  });

  test("reopen → the first unstarted state; an open issue is left alone", async () => {
    const link = await create("Again");
    linear.find(link.id)!.stateId = "st-doing";
    await ok("reopen", { link });
    expect(linear.find(link.id)!.stateId).toBe("st-doing");
    await ok("close", { link, reason: "completed" });
    await ok("reopen", { link });
    expect(linear.find(link.id)!.stateId).toBe("st-todo");
  });

  test("team states are read once per 10 minutes", async () => {
    const a = await create("a"), b = await create("b");
    await ok("close", { link: a, reason: "completed" });
    await ok("close", { link: b, reason: "completed" });
    expect(linear.queries().filter((q) => q === "TeamStates")).toHaveLength(1);
    clock += CACHE_MS + 1;
    await ok("reopen", { link: a });
    expect(linear.queries().filter((q) => q === "TeamStates")).toHaveLength(2);
  });

  test("closing an issue Linear no longer has is not_found", async () => {
    const a = await call("close", { link: { id: "uuid-404", ref: "TST-404", url: "" }, reason: "completed" });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe("not_found");
  });
});

describe("link / unlink", () => {
  test("link sets the parent; linking again answers already", async () => {
    const p = await create("Parent", undefined, "epic"), c = await create("Child");
    expect(await ok("link", { parent: p, child: c })).toEqual({ ok: true });
    expect(linear.find(c.id)!.parentId).toBe(p.id);
    expect(await ok("link", { parent: p, child: c })).toEqual({ ok: true, already: true });
  });

  test("unlink clears the parent; not linked (or gone) is ok", async () => {
    const p = await create("Parent", undefined, "epic");
    const c = await create("Child", p);
    expect(await ok("unlink", { parent: p, child: c })).toEqual({ ok: true });
    expect(linear.find(c.id)!.parentId).toBeNull();
    expect(await ok("unlink", { parent: p, child: c })).toEqual({ ok: true, already: true });
    expect(await ok("unlink", { parent: p, child: { id: "uuid-404", ref: "TST-404", url: "" } })).toEqual({ ok: true, already: true });
  });

  test("unlink leaves a child under ANOTHER parent where it is", async () => {
    const p = await create("P", undefined, "epic"), q = await create("Q", undefined, "epic");
    const c = await create("C", q);
    await ok("unlink", { parent: p, child: c });
    expect(linear.find(c.id)!.parentId).toBe(q.id);
  });
});

describe("update / getIssue", () => {
  test("update writes title and description; an empty patch makes no call", async () => {
    const link = await create("Old");
    await ok("update", { link, patch: { title: "New", body: "new body" } });
    expect(linear.find(link.id)).toMatchObject({ title: "New", description: "new body" });
    const n = linear.calls.length;
    await ok("update", { link, patch: {} });
    expect(linear.calls.length).toBe(n);
  });

  test("getIssue: title, body, open/closed, comments oldest first only when asked", async () => {
    const link = await create("Spec");
    const i = linear.find(link.id)!;
    i.comments = [
      { body: "second", createdAt: "2026-01-02T00:00:00Z", user: null, botActor: { name: "Bot" } },
      { body: "first", createdAt: "2026-01-01T00:00:00Z", user: { name: "tp", displayName: "Test Person" }, botActor: null },
    ];
    const plain = await ok("getIssue", { link });
    expect(plain).toEqual({ ok: true, title: "Spec", body: "Spec body", state: "open" });
    await ok("close", { link, reason: "not_planned" });
    const full = await ok("getIssue", { link, comments: true });
    expect(full.state).toBe("closed");
    expect(full.comments).toEqual([{ author: "Test Person", body: "first" }, { author: "Bot", body: "second" }]);
  });
});

describe("import: resolveRef / listOpen", () => {
  test("by ref, any case, and by linear.app URL of this workspace", async () => {
    const link = await create("Imported one");
    for (const input of ["TST-1", "tst-1", " https://linear.app/acme-test/issue/TST-1/imported-one ", "linear.app/acme-test/issue/TST-1"]) {
      expect(await ok("resolveRef", { input })).toEqual({ ok: true, link, title: "Imported one" });
    }
  });

  test("another workspace's URL, a GitHub ref and an unknown ref are not_found with a sentence", async () => {
    await create("x");
    for (const [input, says] of [
      ["https://linear.app/elsewhere/issue/TST-1/x", "elsewhere"],
      ["#287", "not a Linear issue"],
      ["https://github.com/acme/app/issues/3", "not a Linear issue"],
      ["TST-99", "TST-99 is not an issue in Acme Test"],
    ] as const) {
      const a = await call("resolveRef", { input });
      expect(a.ok).toBe(false);
      if (!a.ok) { expect(a.code).toBe("not_found"); expect(a.error).toContain(says); }
    }
  });

  test("listOpen: the team's open issues, newest first, filtered by title, capped", async () => {
    await create("alpha one"); await create("beta"); const done = await create("alpha done");
    await ok("close", { link: done, reason: "completed" });
    expect((await ok("listOpen", {})).issues.map((i) => i.ref)).toEqual(["TST-2", "TST-1"]);
    expect((await ok("listOpen", { query: "ALPHA" })).issues.map((i) => i.title)).toEqual(["alpha one"]);
    await ok("listOpen", { limit: 500 });
    expect(linear.calls.at(-1)!.variables.first).toBe(50);
  });

  test("parseRef", () => {
    expect(parseRef("ab_c-12")).toEqual({ identifier: "AB_C-12" });
    expect(parseRef("https://linear.app/Acme/issue/ENG-5/some-title?x=1")).toEqual({ identifier: "ENG-5", urlKey: "acme" });
    expect(parseRef("42")).toBeNull();
    expect(parseRef("https://linear.app/acme/project/foo-123")).toBeNull();
  });
});

describe("status / options", () => {
  test("no key at all → not ready, pointing at Settings › Linear", async () => {
    spaces = [];
    expect(await ok("status", {}, {})).toEqual({ ok: true, ready: false, why: NO_KEY, settingsKey: SETTINGS_KEY });
  });

  test("keys but no workspace/team picked → not ready, pointing at the project's fields", async () => {
    expect(await ok("status", {}, {})).toEqual({ ok: true, ready: false, why: PICK });
    expect(await ok("status", {}, { workspace: WS.id })).toEqual({ ok: true, ready: false, why: PICK_TEAM });
  });

  test("a workspace whose key is gone → unconfigured sentence + settingsKey", async () => {
    keys.clear();
    const a = await ok("status");
    expect(a.ready).toBe(false);
    expect(a.settingsKey).toBe(SETTINGS_KEY);
  });

  test("ready once the key sees the team; cached for a minute", async () => {
    expect(await ok("status")).toEqual({ ok: true, ready: true });
    await ok("status");
    expect(linear.queries().filter((q) => q === "Team")).toHaveLength(1);
    expect((await ok("status", {}, { ...CONFIG, team: "team-unknown" })).ready).toBe(false);
  });

  test("a rejected key → not ready + settingsKey, the workspace is marked rejected, and recovers on success", async () => {
    keys.set(WS.id, "fake-linear-key-revoked-000000000000000");
    const a = await ok("status");
    expect(a).toMatchObject({ ready: false, settingsKey: SETTINGS_KEY });
    expect(a.why).toContain("rejected the key for Acme Test");
    expect(spaces[0]!.status).toBe("rejected");
    const c = await call("create", { item: { kind: "issue", title: "x", body: "" } });
    expect(c.ok ? null : c.code).toBe("auth");
    keys.set(WS.id, FAKE_KEY);
    await ok("create", { item: { kind: "issue", title: "x", body: "" } });
    expect(spaces[0]!.status).toBe("ok");
  });

  test("options: workspaces from the stored keys, teams from Linear", async () => {
    expect(await ok("options", { field: "workspace" }, {})).toEqual({ ok: true, options: [{ value: WS.id, label: WS.name }] });
    const t = await ok("options", { field: "team" }, { workspace: WS.id });
    expect(t.options).toContainEqual({ value: TEAM.id, label: "Throwaway (TST)" });
    const bad = await call("options", { field: "label" });
    expect(bad.ok ? null : bad.code).toBe("invalid");
  });
});

describe("failures", () => {
  test("rate limits and outages map onto the contract's codes", async () => {
    const link = await create("x");
    linear.failNext(new LinearError("rate", "Linear's rate limit is reached; try again in a few minutes"));
    const a = await call("getIssue", { link });
    expect(a.ok ? null : a.code).toBe("rate_limited");
    linear.failNext(new LinearError("network", "Could not reach Linear"));
    const b = await call("close", { link, reason: "completed" });
    expect(b).toEqual({ ok: false, code: "unavailable", error: "Could not reach Linear" });
  });

  test("an unexpected throw never leaks its message", async () => {
    const h = createHandlers({
      gql: async () => { throw new Error(`boom ${FAKE_KEY}`); },
      workspaces: () => spaces, workspace: () => spaces[0]!, keyOf: () => FAKE_KEY, setStatus: () => {},
    });
    const a = await answerTracker(h, { op: "getIssue", project, config: CONFIG, link: { id: "x", ref: "TST-1", url: "" } });
    expect(JSON.stringify(a)).not.toContain(FAKE_KEY);
  });

  test("403 is not a bad key: the workspace stays ok and the sentence says write access", async () => {
    const link = await create("x");
    linear.failNext(new LinearError("forbidden", "Linear refused: the key may not do this"));
    const a = await call("close", { link, reason: "completed" });
    expect(a.ok ? null : [a.code, a.error]).toEqual(["auth", "Linear refused: the key may not do this. The key for Acme Test needs write access to this team."]);
    expect(spaces[0]!.status).toBe("ok");
  });

  test("a rejected mark is lifted only when Linear actually answered", async () => {
    spaces = [pub("rejected")];
    await call("resolveRef", { input: "not a ref" });
    expect(spaces[0]!.status).toBe("rejected");
    await ok("listOpen");
    expect(spaces[0]!.status).toBe("ok");
  });

  test("resolveRef never repeats what was pasted", async () => {
    const pasted = ["lin", "api", "0".repeat(40)].join("_"); // built here so the secret scan does not flag it
    const a = await call("resolveRef", { input: pasted });
    expect(JSON.stringify(a)).not.toContain(pasted);
  });

  test("every request of an op shares one budget under the board's 15 s timeout", async () => {
    const seen: number[] = [];
    const h = createHandlers({
      gql: (async (k: string, q: string, v?: Record<string, unknown>, t?: number) => { seen.push(t!); return linear.gql(k, q, v); }) as typeof linear.gql,
      workspaces: () => spaces, workspace: () => spaces[0]!, keyOf: () => FAKE_KEY, setStatus: () => {},
    });
    await answerTracker(h, { op: "create", project, config: { ...CONFIG, label: "new-label" }, item: { kind: "issue", title: "t", body: "" } });
    expect(seen).toHaveLength(3);
    expect(Math.max(...seen)).toBeLessThanOrEqual(OP_BUDGET_MS);
    expect(seen[2]!).toBeLessThanOrEqual(seen[0]!);
  });

  test("ops it does not offer answer unsupported (adopt, branchCut)", async () => {
    for (const op of ["adopt", "branchCut"] as const) {
      const a = await call(op, { items: [], branch: "x" });
      expect(a.ok ? null : a.code).toBe("unsupported");
    }
  });
});
