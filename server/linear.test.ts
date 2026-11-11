import { afterEach, describe, expect, test } from "bun:test";
import { gql, LINEAR_GRAPHQL, LinearError, scrub } from "./linear.js";
import { VIEWER } from "./queries.js";

// Invented: never a real key.
const KEY = "fake-linear-key-for-tests-0123456789abcd";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function answer(body: unknown, init: ResponseInit = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, i: RequestInit) => {
    calls.push({ url, init: i });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
  }) as unknown as typeof fetch;
  return calls;
}
async function failure(p: Promise<unknown>): Promise<LinearError> {
  try { await p; } catch (e) { if (e instanceof LinearError) return e; throw e; }
  throw new Error("expected a LinearError");
}

describe("gql", () => {
  test("posts the query with the bare key and answers data", async () => {
    const calls = answer({ data: { viewer: { id: "u" } } });
    expect(await gql<unknown>(KEY, VIEWER, { a: 1 })).toEqual({ viewer: { id: "u" } });
    expect(calls[0]!.url).toBe(LINEAR_GRAPHQL);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(KEY);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ query: VIEWER, variables: { a: 1 } });
  });

  test("401 / AUTHENTICATION_ERROR → auth, with a fixed sentence", async () => {
    answer({ errors: [{ message: `bad key ${KEY}`, extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 401 });
    const e = await failure(gql(KEY, VIEWER));
    expect(e.kind).toBe("auth");
    expect(e.message).toBe("Linear rejected the key");
  });

  test("403 / FORBIDDEN → forbidden (not a bad key)", async () => {
    answer({ errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] }, { status: 403 });
    expect((await failure(gql(KEY, VIEWER))).kind).toBe("forbidden");
  });

  test("RATELIMITED → rate", async () => {
    answer({ errors: [{ message: "slow down", extensions: { code: "RATELIMITED" } }] }, { status: 400 });
    expect((await failure(gql(KEY, VIEWER))).kind).toBe("rate");
  });

  test("Entity not found → not_found; other GraphQL errors → invalid with Linear's words", async () => {
    answer({ errors: [{ message: "Entity not found: Issue", extensions: { code: "INVALID_INPUT" } }], data: null });
    expect((await failure(gql(KEY, VIEWER))).kind).toBe("not_found");
    answer({ errors: [{ message: "Argument Validation Error", extensions: { userPresentableMessage: "Title is too long" } }] });
    const e = await failure(gql(KEY, VIEWER));
    expect([e.kind, e.message]).toEqual(["invalid", "Linear: Title is too long"]);
  });

  test("a message that echoes the key is scrubbed", async () => {
    answer({ errors: [{ message: `cannot use ${KEY} here` }] });
    const e = await failure(gql(KEY, VIEWER));
    expect(e.message).not.toContain(KEY);
    expect(e.message).toContain("[key]");
  });

  test("network failure and non-JSON 5xx", async () => {
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect((await failure(gql(KEY, VIEWER))).kind).toBe("network");
    answer("<html>oops</html>", { status: 503 });
    const e = await failure(gql(KEY, VIEWER));
    expect([e.kind, e.message]).toEqual(["http", "Linear answered with an error"]);
  });

  test("scrub ignores short keys", () => {
    expect(scrub("abc", "")).toBe("abc");
    expect(scrub("xx-secret-key-xx", "secret-key")).toBe("xx-[key]-xx");
  });
});
