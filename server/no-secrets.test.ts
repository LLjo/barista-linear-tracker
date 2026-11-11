import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..");

/** Every file the plugin repo would publish: tracked + not ignored. */
function files(): string[] {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("no secrets in the repo", () => {
  test("no Linear API key, bearer token or GitHub token in any published file", () => {
    const list = files();
    expect(list.length).toBeGreaterThan(5);
    const hits = list.flatMap((f) => {
      let text = "";
      try { text = readFileSync(join(ROOT, f), "utf8"); } catch { return []; }
      return [/lin_api_[A-Za-z0-9]{16,}/, /lin_oauth_[A-Za-z0-9]{16,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /Bearer\s+[A-Za-z0-9._-]{20,}/]
        .filter((re) => re.test(text)).map((re) => `${f}: ${re}`);
    });
    expect(hits).toEqual([]);
  });
});
