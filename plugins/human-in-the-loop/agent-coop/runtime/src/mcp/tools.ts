// The v1 MCP tools, one row each of contract-design.md §MCP tools table.
//
// NO TOOL WAITS. Waiting for the user's submit is the harness's job, over
// `GET /api/turn/wait` (scripts/watch.ts): an MCP client request that outlives
// the client's own request timeout fails with JSON-RPC `-32001`, so a wait tool
// turns "the user is thinking" into a broken tool call. Adding one back here
// re-opens that hole; the endpoint stays, the tool does not exist.
//
// This module is pure mapping: tool name + args -> one HTTP request against
// the single writer process, and the response -> either the endpoint's body or
// an `McpToolError` (D15). It holds no SQLite handle, no Yjs doc, and imports
// nothing from `src/engine` or `src/server` (repo-design §mapping table).
import { z } from "zod";
import {
  ApplyPayloadSchema,
  DocAddSchema,
  McpToolErrorSchema,
  idString,
  pathString,
  textString,
  type McpToolError,
} from "../contract/index.ts";

export type ToolRequest = {
  method: "GET" | "POST";
  /** Path only, always beginning with `/api/`. The base URL is added by the caller. */
  path: string;
  /** Absent for GETs; JSON body for POSTs. */
  body?: unknown;
};

export type ToolDef = {
  name: string;
  description: string;
  /**
   * Zod raw shape, handed straight to `registerTool({ inputSchema })`.
   *
   * Every string field is built from src/contract/limits.ts (`idString`,
   * `textString`, `pathString`) — never a bare `z.string()`. The caps are the
   * seam's, so the MCP end refuses an over-long argument the same way the HTTP
   * end does instead of forwarding it to be 400'd a round trip later.
   */
  input: z.ZodRawShape;
  /** Pure: args -> the single HTTP request this tool maps to. */
  request: (args: any) => ToolRequest;
};

const q = (v: string) => encodeURIComponent(v);

export const TOOLS: ToolDef[] = [
  {
    name: "agent_coop_sessions",
    description: "List agent-coop sessions with their current turn state.",
    input: {},
    request: () => ({ method: "GET", path: "/api/sessions" }),
  },
  {
    name: "agent_coop_pull",
    description:
      "Start (or resume) Claude's turn on a session and return the full batch: current blocks, open comments and the user's edits since the last revision. Requires the session to be SUBMITTED or already CLAUDE_TURN.",
    input: { session_id: idString() },
    request: (a: { session_id: string }) => ({
      method: "POST",
      path: `/api/pull/${q(a.session_id)}`,
    }),
  },
  {
    name: "agent_coop_add_doc",
    description:
      "Add a document to an existing session (A1). `blocks` is the starting markdown, one string per block; omit it and the document starts with one empty block, ready to type in. The server mints the doc_id and every block_id; there is no way to name a file on disk. Allowed in any state.",
    input: { session_id: idString(), ...DocAddSchema.shape },
    // `blocks` is OMITTED when the caller omitted it, never sent as `[]`: the
    // contract's default is one empty block (ENTRY-1) and a literal `[]` here
    // would talk past it and mint a document nobody can type into.
    request: (a: { session_id: string; title: string; blocks?: string[] }) => ({
      method: "POST",
      path: `/api/sessions/${q(a.session_id)}/docs`,
      body: a.blocks === undefined ? { title: a.title } : { title: a.title, blocks: a.blocks },
    }),
  },
  {
    name: "agent_coop_read_doc",
    description:
      "Read a document's blocks. Pass revision_id to read a past revision instead of the current state.",
    input: { doc_id: idString(), revision_id: idString().optional() },
    request: (a: { doc_id: string; revision_id?: string }) => ({
      method: "GET",
      path:
        `/api/docs/${q(a.doc_id)}` +
        (a.revision_id === undefined ? "" : `?revision=${q(a.revision_id)}`),
    }),
  },
  {
    name: "agent_coop_attachment",
    description: "Read one attachment, including its transcript when transcription is done.",
    input: { attachment_id: idString() },
    request: (a: { attachment_id: string }) => ({
      method: "GET",
      path: `/api/attachments/${q(a.attachment_id)}`,
    }),
  },
  {
    name: "agent_coop_revisions",
    description:
      "List every past turn on a document, newest first: each entry's revision label, its turn summary, and its turn_note and narration once one has been written (both null until then). The revision label is what agent_coop_diff accepts as `to`, so this is how to find 'the last turn', or an older one, before narrating it. Allowed in any state.",
    input: { doc_id: idString() },
    request: (a: { doc_id: string }) => ({
      method: "GET",
      path: `/api/revisions/${q(a.doc_id)}`,
    }),
  },
  {
    name: "agent_coop_diff",
    description:
      "Read the structural diff of a document between two revisions: which blocks were added, removed or modified, a word-level diff inside each modified block, and the comment threads active in that span. `to` defaults to the document's current state; `from` defaults to the state at the user's most recent submit (not the previous revision), so calling this with only doc_id answers 'what changed since I last handed this over'. Pass both to compare two named revisions instead: that comparison carries no threads and no author attribution. Allowed in any state.",
    input: { doc_id: idString(), from: idString().optional(), to: idString().optional() },
    // Two independent optional query params, so a single ternary (agent_coop_read_doc's
    // style) does not fit. Built the same way as that one: string concatenation,
    // never URLSearchParams, for one shared style across the file.
    request: (a: { doc_id: string; from?: string; to?: string }) => {
      const params: string[] = [];
      if (a.from !== undefined) params.push(`from=${q(a.from)}`);
      if (a.to !== undefined) params.push(`to=${q(a.to)}`);
      return {
        method: "GET",
        path: `/api/diff/${q(a.doc_id)}` + (params.length === 0 ? "" : `?${params.join("&")}`),
      };
    },
  },
  {
    name: "agent_coop_apply",
    description:
      "Apply block operations to a document during Claude's turn. ALWAYS pass client_edit_id: it is required, and it is the idempotency key, so retrying the same call with the same id is a no-op instead of a duplicate edit. Mint a fresh one per distinct apply. Requires CLAUDE_TURN.",
    input: ApplyPayloadSchema.shape,
    request: (a: z.infer<typeof ApplyPayloadSchema>) => ({
      method: "POST",
      path: `/api/apply/${q(a.doc_id)}`,
      body: { doc_id: a.doc_id, ops: a.ops, client_edit_id: a.client_edit_id },
    }),
  },
  {
    name: "agent_coop_comment_reply",
    description: "Reply to a comment. Allowed in any state; comments are never turn-gated.",
    input: { comment_id: idString(), text: textString() },
    request: (a: { comment_id: string; text: string }) => ({
      method: "POST",
      path: `/api/comments/${q(a.comment_id)}/reply`,
      body: { text: a.text },
    }),
  },
  {
    name: "agent_coop_comment_resolve",
    description:
      "Resolve a comment. Allowed in any state and regardless of who authored it (D7).",
    input: { comment_id: idString() },
    request: (a: { comment_id: string }) => ({
      method: "POST",
      path: `/api/comments/${q(a.comment_id)}/resolve`,
      body: { resolved_by: "claude" },
    }),
  },
  {
    name: "agent_coop_snapshot",
    description:
      "Close Claude's turn: record a revision with a turn summary and hand control back to the user. Requires CLAUDE_TURN.",
    input: { session_id: idString(), turn_summary: textString() },
    request: (a: { session_id: string; turn_summary: string }) => ({
      method: "POST",
      path: `/api/snapshot/${q(a.session_id)}`,
      body: { turn_summary: a.turn_summary },
    }),
  },
  {
    name: "agent_coop_note",
    description:
      "Store a turn note on a past revision: `note` is markdown for the eye, an interpretation of the turn rather than a transcript, and `narration` is the same content flattened for an ear (tables become sentences, code fences become descriptions). `revision_id` is the revision LABEL from agent_coop_revisions, never a row id. Writing a second note for the same revision is legal and replaces it; the log keeps both. Allowed in any state: a note describes a turn that has already closed, so by definition it is written outside CLAUDE_TURN.",
    input: { doc_id: idString(), revision_id: idString(), note: textString(), narration: textString() },
    request: (a: { doc_id: string; revision_id: string; note: string; narration: string }) => ({
      method: "POST",
      path: `/api/notes/${q(a.doc_id)}`,
      body: { revision_id: a.revision_id, note: a.note, narration: a.narration },
    }),
  },
  {
    name: "agent_coop_export",
    description:
      "Export a document's markdown to disk. `path` is optional and must stay inside the project's artifacts/ directory: relative paths resolve under it, an absolute path is accepted only if it already points inside it, and anything escaping it is refused with 400. With no path at all the file is named after the document. Allowed in any state.",
    input: { doc_id: idString(), path: pathString().optional() },
    request: (a: { doc_id: string; path?: string }) => ({
      method: "POST",
      path: `/api/export/${q(a.doc_id)}`,
      body: a.path === undefined ? {} : { path: a.path },
    }),
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** True when the value is the contract's error shape rather than a success body. */
export function isToolError(value: unknown): value is McpToolError {
  return McpToolErrorSchema.safeParse(value).success;
}

export type Fetcher = (req: Request) => Promise<Response>;

export type CallResult =
  | { ok: true; value: unknown }
  | { ok: false; error: McpToolError };

/**
 * One tool call = one HTTP request. Never throws for a non-2xx: the server
 * answers every failure with an `McpToolError` body (server/errors.ts maps the
 * engine's domain code onto it), and a transport failure is coerced into the
 * same shape here so Claude only ever reads `state` / `retry_after_submit`
 * (contract-design §MCP error shape, D15).
 *
 * This function is the MCP end of that translation, and the only one: nothing
 * below src/mcp reads an HTTP status, and nothing in src/engine produces one.
 */
export async function callTool(
  baseUrl: string,
  name: string,
  args: unknown,
  fetcher: Fetcher = (req) => globalThis.fetch(req),
): Promise<CallResult> {
  const tool = toolByName(name);
  if (tool === undefined) {
    return { ok: false, error: unavailable(`unknown tool ${name}`) };
  }

  let spec: ToolRequest;
  try {
    spec = tool.request(args ?? {});
  } catch (err) {
    return { ok: false, error: unavailable(`invalid arguments for ${name}: ${String(err)}`) };
  }

  // content-type on every POST, body or not: the server refuses a write that
  // does not declare JSON (src/server/guard.ts, SEC-5), and two of these tools
  // POST with no body.
  const request = new Request(baseUrl.replace(/\/$/, "") + spec.path, {
    method: spec.method,
    headers: spec.method === "GET" ? {} : { "content-type": "application/json" },
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
  });

  let response: Response;
  try {
    response = await fetcher(request);
  } catch (err) {
    return {
      ok: false,
      error: unavailable(`agent-coop server unreachable at ${baseUrl}: ${String(err)}`),
    };
  }

  let body: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (response.ok) return { ok: true, value: body };

  const parsed = McpToolErrorSchema.safeParse(body);
  if (parsed.success) return { ok: false, error: parsed.data };
  return {
    ok: false,
    error: unavailable(`agent-coop server returned ${response.status} with no error body`),
  };
}

/**
 * Fallback error for failures that never reached the server's error shape: an
 * unreachable server, an unknown tool, arguments that would not build a request,
 * a non-2xx with no body.
 *
 * It carries NO `state`, because in every one of those cases no session was
 * looked up. It used to say "USER_EDITING" — a projected state asserted by the
 * one code path that could not have read one, and the field Claude uses to
 * decide whether to wait for a submit. Absent means "not known"
 * (src/contract/session.ts).
 */
function unavailable(message: string): McpToolError {
  return { error: message, retry_after_submit: false };
}
