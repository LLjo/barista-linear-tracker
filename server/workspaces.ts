import { db } from "./db.js";

/** A workspace as anything outside keys.ts sees it: never the key, only its last 4 characters. */
export interface WorkspacePublic {
  id: string; name: string; urlKey: string; viewerName: string; keyLast4: string;
  status: "ok" | "rejected"; addedAt: string; checkedAt: string | null;
}

interface Row {
  id: string; name: string; url_key: string; viewer_name: string; key_last4: string;
  status: string; added_at: string; checked_at: string | null;
}
const COLUMNS = "id, name, url_key, viewer_name, key_last4, status, added_at, checked_at";

const fromRow = (r: Row): WorkspacePublic => ({
  id: r.id, name: r.name, urlKey: r.url_key, viewerName: r.viewer_name, keyLast4: r.key_last4,
  status: r.status === "rejected" ? "rejected" : "ok", addedAt: r.added_at, checkedAt: r.checked_at,
});

export function listWorkspaces(): WorkspacePublic[] {
  return db.query<Row>(`SELECT ${COLUMNS} FROM linear_tracker_workspaces ORDER BY added_at, id`).map(fromRow);
}

export function getWorkspace(id: string): WorkspacePublic | null {
  const r = db.get<Row>(`SELECT ${COLUMNS} FROM linear_tracker_workspaces WHERE id = ?`, [id]);
  return r ? fromRow(r) : null;
}

/** Linear refused the key (an op answered 401): `status` says so until a new key is pasted. */
export function setStatus(id: string, status: "ok" | "rejected", now = new Date().toISOString()): void {
  db.run("UPDATE linear_tracker_workspaces SET status = ?, checked_at = ? WHERE id = ?", [status, now, id]);
}
