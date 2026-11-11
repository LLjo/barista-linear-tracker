import { describe, expect, test } from "bun:test";
import { LINEAR_GRAPHQL } from "./linear.js";
import { ALL } from "./queries.js";

// Opt-in (network): LINEAR_SCHEMA_CHECK=1 bun test. No key is sent. Linear validates a query before it
// checks auth, so AUTHENTICATION_ERROR means the text is valid and GRAPHQL_VALIDATION_FAILED means it is not.
describe.skipIf(process.env.LINEAR_SCHEMA_CHECK !== "1")("queries against Linear's live schema", () => {
  for (const q of ALL) {
    const name = q.split(/[ ({]/)[1];
    test(`${name} is valid`, async () => {
      const r = await fetch(LINEAR_GRAPHQL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }) });
      const b = (await r.json()) as { errors?: { message: string; extensions?: { code?: string } }[] };
      expect(b.errors?.map((e) => e.extensions?.code)).toEqual(["AUTHENTICATION_ERROR"]);
    }, 20_000);
  }
});
