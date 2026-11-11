import { barista } from "@barista/plugin-sdk";
import plugin from "../plugin.js";
import { closeDb, db } from "./db.js";
import { getKey } from "./keys.js";
import { gql } from "./linear.js";
import routes from "./routes.js";
import { createHandlers } from "./tracker.js";
import { getWorkspace, listWorkspaces, setStatus } from "./workspaces.js";

plugin.server.registerRoutes(routes);
// contributes.tracker: the board asks every op on S.pluginTracker("linear-tracker").
const tracker = barista.trackers.serve(createHandlers({ gql, workspaces: listWorkspaces, workspace: getWorkspace, keyOf: getKey, setStatus }));
plugin.server.registerHealthCheck(async () => ({ ok: db.health() }));
plugin.server.registerShutdown(() => {
  tracker.stop();
  closeDb();
});
await plugin.server.start();
