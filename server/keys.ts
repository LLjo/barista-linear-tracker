import { db } from "./db.js";

/**
 * The ONLY module that reads or writes the `api_key` column. Every other query names its columns, and
 * nothing this plugin answers (routes, tracker ops, logs) carries a key: at most its last 4 characters.
 */
export function getKey(workspaceId: string): string | null {
  return db.get<{ api_key: string }>("SELECT api_key FROM linear_tracker_workspaces WHERE id = ?", [workspaceId])?.api_key ?? null;
}

export const last4 = (key: string) => key.slice(-4);

export interface NewWorkspace { id: string; name: string; urlKey: string; viewerName: string }

/** Upsert by organization id: a second key for the same workspace replaces the first. */
export function putKey(w: NewWorkspace, key: string, now = new Date().toISOString()): void {
  db.run(
    `INSERT INTO linear_tracker_workspaces (id, name, url_key, viewer_name, api_key, key_last4, status, added_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, url_key = excluded.url_key, viewer_name = excluded.viewer_name,
       api_key = excluded.api_key, key_last4 = excluded.key_last4, status = 'ok', checked_at = excluded.checked_at`,
    [w.id, w.name, w.urlKey, w.viewerName, key, last4(key), now, now],
  );
}

export function removeKey(workspaceId: string): boolean {
  return db.run("DELETE FROM linear_tracker_workspaces WHERE id = ?", [workspaceId]).changes > 0;
}
