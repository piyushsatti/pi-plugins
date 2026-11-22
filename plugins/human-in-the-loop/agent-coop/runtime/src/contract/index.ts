// src/contract — the only machine-readable definition of agent-coop's seams (R1).
// Schemas + types + DDL only; no logic (repo-design §Architecture mapping).
export const contract_version = "1.0.0";

export * from "./limits.ts";
export * from "./blocks.ts";
export * from "./anchor.ts";
export * from "./comment.ts";
export * from "./attachment.ts";
export * from "./session.ts";
export * from "./errors.ts";
export * from "./events.ts";
export * from "./pull.ts";
export * from "./diff.ts";
export * from "./revision.ts";
export * from "./turn.ts";
export * from "./apply.ts";
export * from "./sse.ts";
