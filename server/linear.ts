/**
 * Linear's GraphQL API, one request at a time. The key rides only in the `Authorization` header: it is
 * never logged, and no error message is built from the request. `LinearError.message` is either a fixed
 * sentence of ours or Linear's own `errors[].message`, with the key scrubbed out in case it was echoed.
 */

export const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
export const REQUEST_TIMEOUT_MS = 15_000;

export type LinearErrorKind = "auth" | "rate" | "not_found" | "invalid" | "network" | "http";

export class LinearError extends Error {
  constructor(readonly kind: LinearErrorKind, message: string) {
    super(message);
    this.name = "LinearError";
  }
}

interface GqlError { message?: string; extensions?: { code?: string; type?: string; userPresentableMessage?: string } }
interface GqlBody<T> { data?: T | null; errors?: GqlError[] }

/** Remove `key` from `text` wherever it appears (Linear never echoes it; this makes sure of it). */
export const scrub = (text: string, key: string): string => (key && key.length >= 8 ? text.split(key).join("[key]") : text);

const kindOf = (status: number, errors: GqlError[]): LinearErrorKind | null => {
  const codes = errors.map((e) => `${e.extensions?.code ?? ""} ${e.extensions?.type ?? ""}`.toUpperCase());
  if (status === 401 || codes.some((c) => c.includes("AUTHENTICATION"))) return "auth";
  if (status === 403 || codes.some((c) => c.includes("FORBIDDEN"))) return "auth";
  if (status === 429 || codes.some((c) => c.includes("RATELIMITED"))) return "rate";
  const text = errors.map((e) => e.message ?? "").join(" ");
  if (/entity not found|could not find/i.test(text)) return "not_found";
  if (errors.length) return "invalid";
  return null;
};

const FIXED: Record<LinearErrorKind, string> = {
  auth: "Linear rejected the key",
  rate: "Linear's rate limit is reached; try again in a few minutes",
  not_found: "Linear has no such issue",
  invalid: "Linear refused the request",
  network: "Could not reach Linear",
  http: "Linear answered with an error",
};

export type Gql = <T>(key: string, query: string, variables?: Record<string, unknown>) => Promise<T>;

/** One GraphQL request. Personal API keys are sent bare (no `Bearer`). Throws a {@link LinearError}. */
export const gql: Gql = async <T>(key: string, query: string, variables: Record<string, unknown> = {}): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(LINEAR_GRAPHQL, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new LinearError("network", timeout ? `Linear did not answer within ${REQUEST_TIMEOUT_MS / 1000} s` : FIXED.network);
  }
  let body: GqlBody<T> | null = null;
  try {
    body = (await res.json()) as GqlBody<T>;
  } catch {
    body = null;
  }
  const errors = Array.isArray(body?.errors) ? body!.errors : [];
  const kind = kindOf(res.status, errors) ?? (!res.ok ? "http" : body?.data ? null : "invalid");
  if (kind) {
    const e = errors.find((x) => typeof x.extensions?.userPresentableMessage === "string" || typeof x.message === "string");
    const said = e?.extensions?.userPresentableMessage ?? e?.message;
    const msg = kind === "auth" || kind === "rate" || !said ? FIXED[kind] : `Linear: ${said}`;
    throw new LinearError(kind, scrub(msg.slice(0, 300), key));
  }
  return body!.data as T;
};
