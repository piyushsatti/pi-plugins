// HTTP plumbing: one error shape everywhere. Every non-2xx body is an
// `McpToolError` (contract-design §MCP error shape, D15) — including 400s and
// 404s — so the MCP shim has exactly one failure shape to translate and never
// has to parse a message string.
import type { TypeOf, ZodTypeAny } from "zod";
import { contract_version, type McpToolError, type SessionState } from "../contract/index.ts";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-agent-coop-contract-version": contract_version },
  });
}

/**
 * Every non-2xx body. `state` is passed only by a caller that LOOKED IT UP —
 * omitted, the field is absent from the body rather than defaulted.
 *
 * It used to default to "USER_EDITING", which made a 404 for an unknown session
 * assert the state of a session that does not exist. Claude reads that field to
 * decide whether to wait for a submit; an invented value is a wrong answer with
 * the shape of a right one.
 */
export function fail(
  status: number,
  error: string,
  state?: SessionState,
  retry_after_submit = false,
): Response {
  const body: McpToolError = { error, retry_after_submit };
  if (state !== undefined) body.state = state;
  return json(body, status);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

/** Zod validation on every request body. Nothing reaches a handler unparsed.
 *  The schema itself is the type parameter, not its output: inferring through
 *  `ZodType<T>` picks up the *input* side, which re-widens every `.default()`
 *  back to `| undefined` at the call site. */
export async function parseBody<S extends ZodTypeAny>(
  req: Request,
  schema: S,
  state?: SessionState,
): Promise<Parsed<TypeOf<S>>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: fail(400, "request body is not valid JSON", state) };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, response: fail(400, `invalid request body: ${result.error.message}`, state) };
  }
  return { ok: true, value: result.data };
}
