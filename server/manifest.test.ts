import { describe, expect, test } from "bun:test";
import { sanitizePluginSettings } from "@barista/types/plugin-settings";
import { sanitizeTracker } from "@barista/types/tracker";
import manifest from "../manifest.json";
import { SETTINGS_KEY } from "./tracker.js";

describe("manifest", () => {
  test("contributes.tracker survives the board's parser unchanged (design §1.1)", () => {
    const t = sanitizeTracker(manifest.contributes.tracker)!;
    expect(t.label).toBe("Linear");
    expect(t.legacy).toBe(false);
    expect(t.capabilities).toEqual({
      epics: true, subIssues: true, numbering: "barista", branchNames: true, remoteBranch: false,
      import: true, listOpen: true, comments: true, reopen: true,
    });
    expect(t.projectFields.map((f) => f.key)).toEqual(["workspace", "team", "label"]);
    expect(t.projectFields[1]).toMatchObject({ options: "dynamic", required: true, dependsOn: "workspace" });
  });

  test("its Settings section is the key `status` points at", () => {
    expect(sanitizePluginSettings(manifest.settings)?.key).toBe(SETTINGS_KEY);
    expect(manifest.name).toBe("linear-tracker");
  });
});
