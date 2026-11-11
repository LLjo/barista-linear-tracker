import { openStorage, type Storage } from "@barista/plugin-sdk/sqlite";
import { chmodSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.PLUGIN_DATA_DIR
  ? join(process.env.PLUGIN_DATA_DIR, "linear-tracker")
  : join(import.meta.dirname, "..", "data");

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try {
  chmodSync(DATA_DIR, 0o700);
} catch {
  // not ours to change (a shared mount): the file itself is still 0600
}
export const db: Storage = await openStorage({ dir: DATA_DIR, name: "linear-tracker" });
// The file holds API keys: owner-only. The host is the trust boundary (no encryption at rest).
for (const p of [db.path, `${db.path}-wal`, `${db.path}-shm`]) {
  try {
    chmodSync(p, 0o600);
  } catch {
    // -wal / -shm may not exist yet
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS linear_tracker_workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL, url_key TEXT NOT NULL,
    viewer_name TEXT NOT NULL,
    api_key TEXT NOT NULL, key_last4 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    added_at TEXT NOT NULL, checked_at TEXT
  );
`);

/** Checkpoint the WAL and close — registered with `registerShutdown` in index.ts. */
export function closeDb(): void {
  db.close();
}
