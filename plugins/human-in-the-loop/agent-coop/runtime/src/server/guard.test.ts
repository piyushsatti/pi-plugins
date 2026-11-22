import { expect, mock, test } from "bun:test";

// http.ts only needs this value; the contract barrel also loads absent Zod schemas.
mock.module("../contract/index.ts", () => ({ contract_version: "1.0.0" }));
const { guardRequest } = await import("./guard.ts");

for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} refuses an unlisted Host`, () => {
    const req = new Request("http://localhost:4317/api/docs/example-doc", {
      method,
      headers: { host: "attacker.example", "content-type": "application/json" },
    });
    expect(guardRequest(req)?.status).toBe(403);
  });
}

for (const host of ["127.0.0.1:4317", "localhost", "[::1]:4317"]) {
  test(`GET allows loopback Host ${host}`, () => {
    const req = new Request("http://localhost:4317/api/docs/example-doc", { headers: { host } });
    expect(guardRequest(req)).toBeNull();
  });
}

test("GET allows a listed Host", () => {
  const req = new Request("http://localhost:4317/api/docs/example-doc", {
    headers: { host: "example.invalid:4317" },
  });
  expect(guardRequest(req, new Set(["example.invalid"]))).toBeNull();
});

for (const [url, status] of [
  ["http://localhost:4317/api/docs/example-doc", undefined],
  ["http://attacker.example:4317/api/docs/example-doc", 403],
] as const) {
  test(`GET falls back to URL host without a Host header: ${url}`, () => {
    expect(guardRequest(new Request(url))?.status).toBe(status);
  });
}

test("GET does not require write-only headers", () => {
  const req = new Request("http://localhost:4317/api/docs/example-doc", {
    headers: { "content-type": "text/plain", origin: "http://example.invalid", "sec-fetch-site": "cross-site" },
  });
  expect(guardRequest(req)).toBeNull();
});

for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
  test(`POST refuses content-type ${contentType}`, () => {
    const headers = new Headers();
    if (contentType !== undefined) headers.set("content-type", contentType);
    const req = new Request("http://localhost:4317/api/submit", { method: "POST", headers });
    expect(guardRequest(req)?.status).toBe(403);
  });
}

for (const [origin, site, status] of [
  [undefined, undefined, undefined],
  ["http://localhost:4317", "same-origin", undefined],
  ["null", "none", undefined],
  ["http://localhost:4318", "same-origin", 403],
  ["http://example.invalid", "same-origin", 403],
  ["not a URL", "same-origin", 403],
  ["ftp://localhost:4317", "same-origin", 403],
  ["http://localhost:4317", "same-site", 403],
  ["http://localhost:4317", "cross-site", 403],
] as const) {
  test(`POST checks origin ${origin} and sec-fetch-site ${site}`, () => {
    const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
    if (origin !== undefined) headers.set("origin", origin);
    if (site !== undefined) headers.set("sec-fetch-site", site);
    const req = new Request("http://localhost:4317/api/submit", { method: "POST", headers });
    expect(guardRequest(req)?.status).toBe(status);
  });
}

test("POST allows a listed Host only with its own origin", () => {
  const hosts = new Set(["example.invalid"]);
  const headers = new Headers({
    host: "example.invalid:4317",
    "content-type": "application/json",
    origin: "https://example.invalid:4317",
    "sec-fetch-site": "same-origin",
  });
  expect(guardRequest(new Request("http://localhost:4317/api/submit", { method: "POST", headers }), hosts)).toBeNull();
  headers.set("origin", "https://example.invalid:4318");
  expect(guardRequest(new Request("http://localhost:4317/api/submit", { method: "POST", headers }), hosts)?.status).toBe(403);
});
