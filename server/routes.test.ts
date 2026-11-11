import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { answerTracker } from "@barista/types/tracker";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FAKE_KEY, fakeLinear, TEAM, WS } from "./fake-linear.js";

// Invented keys only. The DB goes to a temp dir, set before db.ts is imported.
const KEY = FAKE_KEY;
const KEY2 = "fake-linear-key-acme-second-9876543210zz";
const BAD = "fake-linear-key-rejected-0000000000000000";
const OTHER_WS = "fake-linear-key-other-workspace-00000000";
const dir = mkdtempSync(join(tmpdir(), "linear-tracker-test-"));
process.env.PLUGIN_DATA_DIR = dir;

// Every console line written during this file: none may carry a key.
const logged: string[] = [];
for (const m of ["log", "info", "warn", "error", "debug"] as const) {
  spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
}

const realFetch = globalThis.fetch;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
/** Linear's viewer query, by key. */
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  const key = (init.headers as Record<string, string>).Authorization;
  if (key === BAD) return json({ errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR" } }] }, 401);
  const org = key === OTHER_WS ? { id: "org-2", name: "Other Co", urlKey: "other-co" } : WS;
  return json({ data: { viewer: { id: "user-1", name: "Test Person", organization: org } } });
}) as unknown as typeof fetch;

const { default: app } = await import("./routes.js");
const { getKey } = await import("./keys.js");
const { getWorkspace, listWorkspaces, setStatus } = await import("./workspaces.js");
const { db } = await import("./db.js");
const { createHandlers, STATUS_CACHE_MS } = await import("./tracker.js");

afterAll(() => {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const req = (path: string, method = "GET", body?: unknown) =>
  app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const answers: string[] = [];
async function send(path: string, method = "GET", body?: unknown) {
  const r = await req(path, method, body);
  const text = await r.text();
  answers.push(text);
  return { status: r.status, body: JSON.parse(text) as Record<string, unknown> };
}

describe("key routes", () => {
  test("adding a key checks it with Linear and answers the workspace without the key", async () => {
    const r = await send("/workspaces", "POST", { apiKey: `  ${KEY} ` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: WS.id, name: WS.name, urlKey: WS.urlKey, viewerName: "Test Person", keyLast4: KEY.slice(-4), status: "ok" });
    expect(getKey(WS.id)).toBe(KEY);
  });

  test("the DB file holding keys is owner-only", () => {
    expect(statSync(db.path).mode & 0o777).toBe(0o600);
  });

  test("a rejected key answers a fixed line and stores nothing", async () => {
    const r = await send("/workspaces", "POST", { apiKey: BAD });
    expect(r).toEqual({ status: 400, body: { error: "Linear rejected that key. Check that it was copied in full." } });
    expect(listWorkspaces()).toHaveLength(1);
  });

  test("a malformed body never echoes its input", async () => {
    const r = await send("/workspaces", "POST", { apiKey: "short key with spaces" });
    expect(r).toEqual({ status: 400, body: { error: "That does not look like a Linear API key." } });
  });

  test("replacing a key: same workspace only", async () => {
    expect((await send(`/workspaces/${WS.id}/key`, "PUT", { apiKey: OTHER_WS })).body).toEqual({ error: "That key belongs to another workspace." });
    setStatus(WS.id, "rejected");
    const r = await send(`/workspaces/${WS.id}/key`, "PUT", { apiKey: KEY2 });
    expect(r.body).toMatchObject({ keyLast4: KEY2.slice(-4), status: "ok" });
    expect(getKey(WS.id)).toBe(KEY2);
    expect((await send("/workspaces/nope/key", "PUT", { apiKey: KEY2 })).status).toBe(404);
  });

  test("list and remove", async () => {
    await send("/workspaces", "POST", { apiKey: OTHER_WS });
    const l = await send("/workspaces");
    expect((l.body.workspaces as { id: string }[]).map((w) => w.id)).toEqual([WS.id, "org-2"]);
    expect((await send("/workspaces/org-2", "DELETE")).body).toEqual({ ok: true });
    expect(getKey("org-2")).toBeNull();
    expect((await send("/workspaces/org-2", "DELETE")).status).toBe(404);
  });
});

describe("the tracker on the stored keys", () => {
  test("status is ready once a key is stored and the team is picked; ops file with the stored key", async () => {
    const linear = fakeLinear({ key: KEY2 });
    let clock = 1_000_000;
    const h = createHandlers({ gql: linear.gql, workspaces: listWorkspaces, workspace: getWorkspace, keyOf: getKey, setStatus, now: () => clock });
    const project = { id: "p1", repoUrls: [], defaultBranch: "main" };
    const config = { workspace: WS.id, team: TEAM.id };
    const status = await answerTracker(h, { op: "status", project, config });
    expect(status).toEqual({ ok: true, ready: true });
    const created = await answerTracker(h, { op: "create", project, config, item: { kind: "issue", title: "Hello", body: "" } });
    answers.push(JSON.stringify(status), JSON.stringify(created));
    expect(created).toMatchObject({ ok: true, link: { ref: "TST-1" } });
    // Linear refusing the key marks the workspace; the Settings page shows it.
    removeAndBreak();
    clock += STATUS_CACHE_MS + 1;
    const bad = await answerTracker(h, { op: "status", project, config });
    answers.push(JSON.stringify(bad));
    expect(bad).toMatchObject({ ok: true, ready: false, settingsKey: "linear-tracker" });
    expect(getWorkspace(WS.id)!.status).toBe("rejected");

    function removeAndBreak() { db.run("UPDATE linear_tracker_workspaces SET api_key = ? WHERE id = ?", [BAD, WS.id]); }
  });
});

describe("no key leaves the server", () => {
  test("no answer and no log line carries any key", () => {
    const all = [...answers, ...logged].join("\n");
    for (const k of [KEY, KEY2, BAD, OTHER_WS]) expect(all).not.toContain(k);
  });

  test("only keys.ts reads the api_key column", () => {
    for (const f of ["routes.ts", "tracker.ts", "workspaces.ts", "index.ts", "linear.ts"]) {
      expect(readFileSync(join(import.meta.dirname, f), "utf8")).not.toContain("api_key");
    }
  });
});
