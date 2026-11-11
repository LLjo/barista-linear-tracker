# linear-tracker plugin

Implements Barista's tracker contract (`@barista/types/tracker`, design `docs/design/1541-pluggable-trackers.md` §4 in Barista) for Linear.

- `server/tracker.ts` — every op, built from injected deps; tests drive it through `answerTracker` with `server/fake-linear.ts`.
- `server/keys.ts` is the ONLY reader/writer of the `api_key` column. Nothing else may select it; `routes.test.ts` enforces this.
- `server/linear.ts` never builds an error from the request; messages are fixed sentences or Linear's own, scrubbed of the key.
- Every GraphQL text lives in `server/queries.ts`; after editing one run `LINEAR_SCHEMA_CHECK=1 bun test server/queries.test.ts`.
- Public repo: every fixture, key and workspace in tests is invented. `no-secrets.test.ts` scans published files.
- Call Barista core only through the `barista` SDK.
