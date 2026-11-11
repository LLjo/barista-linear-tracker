import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { putKey, removeKey, type NewWorkspace } from "./keys.js";
import { gql, LinearError } from "./linear.js";
import { VIEWER, type Viewer } from "./queries.js";
import { getWorkspace, listWorkspaces } from "./workspaces.js";

export const MAX_WORKSPACES = 5;
export const REJECTED = "Linear rejected that key. Check that it was copied in full.";
export const NOT_A_KEY = "That does not look like a Linear API key.";

// A bad body answers this fixed line: a key route never echoes its input (the key).
const keyBody = zValidator(
  "json",
  z.object({ apiKey: z.string().trim().min(20).max(200).regex(/^\S+$/) }),
  (r, c) => (r.success ? undefined : c.json({ error: NOT_A_KEY }, 400)),
);

type Checked = { ok: true; ws: NewWorkspace } | { ok: false; status: 400 | 502; error: string };

/** Ask Linear whose key it is. Write access is only proven by the first write; the page says so. */
async function checkKey(key: string): Promise<Checked> {
  try {
    const { viewer } = await gql<Viewer>(key, VIEWER);
    const o = viewer.organization;
    return { ok: true, ws: { id: o.id, name: o.name, urlKey: o.urlKey, viewerName: viewer.name } };
  } catch (e) {
    if (e instanceof LinearError && e.kind === "auth") return { ok: false, status: 400, error: REJECTED };
    return { ok: false, status: 502, error: e instanceof LinearError ? e.message : "Could not check the key with Linear" };
  }
}

const app = new Hono()
  .get("/workspaces", (c) => c.json({ workspaces: listWorkspaces() }))
  .post("/workspaces", keyBody, async (c) => {
    const key = c.req.valid("json").apiKey;
    const checked = await checkKey(key);
    if (!checked.ok) return c.json({ error: checked.error }, checked.status);
    const existing = listWorkspaces();
    if (!existing.some((w) => w.id === checked.ws.id) && existing.length >= MAX_WORKSPACES) {
      return c.json({ error: `At most ${MAX_WORKSPACES} workspaces. Remove one first.` }, 400);
    }
    putKey(checked.ws, key);
    return c.json(getWorkspace(checked.ws.id)!);
  })
  .put("/workspaces/:id/key", keyBody, async (c) => {
    const id = c.req.param("id");
    if (!getWorkspace(id)) return c.json({ error: "No such workspace" }, 404);
    const key = c.req.valid("json").apiKey;
    const checked = await checkKey(key);
    if (!checked.ok) return c.json({ error: checked.error }, checked.status);
    if (checked.ws.id !== id) return c.json({ error: "That key belongs to another workspace." }, 400);
    putKey(checked.ws, key);
    return c.json(getWorkspace(id)!);
  })
  .delete("/workspaces/:id", (c) => {
    if (!removeKey(c.req.param("id"))) return c.json({ error: "No such workspace" }, 404);
    return c.json({ ok: true as const });
  });

export type AppType = typeof app;
export default app;
