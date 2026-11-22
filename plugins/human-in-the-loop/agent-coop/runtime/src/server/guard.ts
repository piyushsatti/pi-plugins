// Host guard on every request; browser checks on writes (SEC-5).
//
// Binding to loopback keeps other machines out. It does NOT keep the user's own
// browser out: any page the user visits can POST to http://localhost:4317, and
// a `text/plain` POST is a CORS *simple* request, so there is no preflight to
// refuse and the response being unreadable does not undo the write. The bind is
// a network boundary, not a browser one.
//
// Host is checked on every request. The other checks apply only to writes:
//
//   Content-Type   must be application/json. This alone removes the simple-request
//                  path: a cross-site fetch cannot set it without a preflight.
//   Host           must be loopback or listed. A DNS-rebinding name resolving
//                  to 127.0.0.1 arrives with its own Host, not ours.
//   Origin /       when present, must be this same origin. Absent Origin is
//   Sec-Fetch-Site allowed because non-browser clients (MCP shim, CLI, curl)
//                  send none — Sec-Fetch-Site is what distinguishes them from a
//                  browser, and browsers always send it.
//
// A failure is 403 with the contract's error body, like every other refusal.
import { fail } from "./http.ts";

/**
 * Is this Host header's name a loopback address?
 *
 * A Host header carries IPv6 BRACKETED (`[::1]:4317`, RFC 3986) — never bare —
 * and the same loopback address has many spellings: `[::1]`, `[0:0:0:0:0:0:0:1]`,
 * `[0000:…:0001]`, `[::ffff:127.0.0.1]`. A literal set of spellings therefore
 * refuses legitimate requests it does not happen to list, so this normalizes
 * instead: brackets off, then group-expand and compare numerically.
 *
 * IPv4 is the whole 127.0.0.0/8 block, not just 127.0.0.1 — every address in it
 * is this machine.
 */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;

  // Bracketed form only: a bare `::1` in a Host header is malformed, and
  // accepting it would mean guessing at where the port stopped.
  if (host.startsWith("[") && host.endsWith("]")) {
    const groups = expandIpv6(host.slice(1, -1));
    if (groups === null) return false;
    // ::1 and ::ffff:127.0.0.1 both end up here: the mapped form's low 32 bits
    // are the IPv4 address, so 127.x.y.z maps to a 0x7f__ group.
    if (groups[5] === 0xffff && groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
        groups[3] === 0 && groups[4] === 0) {
      return groups[6]! >> 8 === 127;
    }
    return groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  }

  const v4 = host.split(".");
  if (v4.length !== 4) return false;
  if (!v4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  return v4[0] === "127";
}

/** The eight 16-bit groups of an IPv6 literal, or null if it is not one. */
function expandIpv6(text: string): number[] | null {
  if (text.includes(".")) {
    // Dotted-quad tail (`::ffff:127.0.0.1`): fold it into two groups first.
    const at = text.lastIndexOf(":");
    const quad = text.slice(at + 1).split(".");
    if (quad.length !== 4 || !quad.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
    const [a, b, c, d] = quad.map(Number) as [number, number, number, number];
    text = `${text.slice(0, at + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

const EMPTY_HOSTS: ReadonlySet<string> = new Set();

/**
 * Parse the AGENT_COOP_ALLOWED_HOSTS form: comma-separated names, trimmed,
 * lowercased, empties dropped. A trailing dot is stripped because tailnet
 * DNSName is reported fully-qualified (`machine.tail….ts.net.`) while a Host
 * header never carries the root dot.
 */
export function parseAllowedHosts(value: string | undefined): ReadonlySet<string> {
  if (!value) return EMPTY_HOSTS;
  return new Set(
    value
      .split(",")
      .map((name) => name.trim().toLowerCase().replace(/\.$/, ""))
      .filter((name) => name.length > 0),
  );
}

/** Methods that change state. Everything else is a pure read (routes/read.ts). */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/**
 * Host without its port, lowercased. IPv6 keeps its brackets, because that is
 * the only form a Host header states it in and the brackets are what say where
 * the address ended and the port began.
 */
export function hostname(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    // No closing bracket: malformed. Returned whole so the loopback test fails
    // it rather than a truncated prefix accidentally passing.
    return close === -1 ? host : host.slice(0, close + 1);
  }
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * Null when the request may proceed, otherwise the 403 to return.
 *
 * Every method checks Host, including reads, SSE and the static bundle.
 * Content-Type, Origin and Sec-Fetch-Site are checked only for writes.
 *
 * `allowedHosts` is the A12 seam: when a reverse proxy on a trusted private
 * network fronts this server (`tailscale serve`, which forwards the tailnet
 * name as Host), that name must be LISTED to read or write. Loopback stays the
 * only default. Names are exact, lowercased, portless. Empty means loopback only.
 * The write Origin and Sec-Fetch-Site checks still hold for a listed host, so
 * listing a name admits that origin's own pages, not the web at large.
 */
export function guardRequest(req: Request, allowedHosts: ReadonlySet<string> = EMPTY_HOSTS): Response | null {
  // A Request built in-process (tests, the MCP shim's fetcher) carries no Host
  // header; its URL is then the only statement of what it addressed.
  const url = new URL(req.url);
  const host = hostname(req.headers.get("host") ?? url.host);
  if (!isLoopbackHost(host) && !allowedHosts.has(host)) {
    return fail(403, `requests must address a loopback or allowed host, not ${host}`);
  }

  if (!isWriteMethod(req.method)) return null;

  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json") {
    return fail(403, "write requests must send content-type: application/json");
  }

  const origin = req.headers.get("origin");
  if (origin !== null && origin !== "" && origin.toLowerCase() !== "null") {
    let originHost: string;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return fail(403, `cross-site write refused: origin ${origin}`);
      }
      originHost = parsed.host.toLowerCase();
    } catch {
      return fail(403, `cross-site write refused: unparseable origin ${origin}`);
    }
    // Compared with the port, unlike the Host check above: a different port on
    // localhost is a different origin to a browser, and so it is here.
    const expected = (req.headers.get("host") ?? url.host).trim().toLowerCase();
    if (originHost !== expected) {
      return fail(403, `cross-site write refused: origin ${origin} is not ${expected}`);
    }
  }

  // Browsers always send this; "none" means the user typed the URL. Anything
  // else (same-site, cross-site) is a page on another origin driving the write.
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return fail(403, `cross-site write refused: sec-fetch-site ${site}`);
  }

  return null;
}
