import { unwrap } from "@barista/plugin-sdk/ui/http";

/** A workspace as the server answers it: never the key, only its last 4 characters. */
export interface WorkspacePublic {
  id: string; name: string; urlKey: string; viewerName: string; keyLast4: string;
  status: "ok" | "rejected"; addedAt: string; checkedAt: string | null;
}

const BASE = "/api/linear-tracker";
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export const listWorkspaces = () => unwrap<{ workspaces: WorkspacePublic[] }>(fetch(`${BASE}/workspaces`));
export const addKey = (apiKey: string) => unwrap<WorkspacePublic>(fetch(`${BASE}/workspaces`, json("POST", { apiKey })));
export const replaceKey = (id: string, apiKey: string) =>
  unwrap<WorkspacePublic>(fetch(`${BASE}/workspaces/${encodeURIComponent(id)}/key`, json("PUT", { apiKey })));
export const removeWorkspace = (id: string) =>
  unwrap<{ ok: true }>(fetch(`${BASE}/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" }));
