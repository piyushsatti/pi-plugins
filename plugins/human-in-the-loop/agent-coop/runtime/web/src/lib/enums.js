// Names for the contract enum VALUES web/ compares against (B2/CQ5).
//
// web/ used to write these as bare string literals — `!== "attached"`,
// `=== "resolved"`, `!== "USER_EDITING"` — which is a hand-copy of the contract
// wearing quotes: rename a value in src/contract and every comparison here
// silently becomes false. Nothing throws, no test fails, and the UI quietly stops
// doing its job. `anchor_state` is the one that makes this more than tidiness:
// PI-6 exists because a highlight was painted over the wrong words while the
// state still read healthy, and the guard against a repeat is a comparison
// against `attached` that cannot go stale.
//
// So each name below is LOOKED UP in the generated arrays rather than typed. A
// value the contract no longer has fails at module load, which is the first
// import of any view.
import {
  ACTORS,
  ANCHOR_STATES,
  CHANGE_KINDS,
  COMMENT_STATUSES,
  DELIVERY_MODES,
  SESSION_STATES,
} from "../contract.gen.js";

function member(values, name) {
  if (!values.includes(name)) {
    throw new Error(`web/src/lib/enums.js expects "${name}" in the contract, found: ${values.join(", ")}`);
  }
  return name;
}

/** The ONLY anchor state a `<mark>` may be painted from (PI-6). */
export const ANCHOR_ATTACHED = member(ANCHOR_STATES, "attached");
/** Head resolves, the run does not: still a block, no longer words. */
export const ANCHOR_DETACHED = member(ANCHOR_STATES, "detached");
/** The anchor's own position is gone. */
export const ANCHOR_ORPHANED = member(ANCHOR_STATES, "orphaned");

export const STATUS_RESOLVED = member(COMMENT_STATUSES, "resolved");

/** The one delivery class with its own affordance (ui-design). */
export const DELIVERY_INTERRUPT = member(DELIVERY_MODES, "interrupt");
export const DELIVERY_DEFAULT = member(DELIVERY_MODES, "queued");

export const ACTOR_USER = member(ACTORS, "user");

/** The one change kind that is not a change: it renders plainly, untagged. */
export const CHANGE_UNCHANGED = member(CHANGE_KINDS, "unchanged");

/** The one state in which blocks are editable. */
export const STATE_USER_EDITING = member(SESSION_STATES, "USER_EDITING");
