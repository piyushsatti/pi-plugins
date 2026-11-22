// Static serving of web/dist (repo-design: web/ reaches data only via the HTTP
// API; the same single process serves its bundle). SPA fallback to index.html.
import { join, normalize } from "node:path";

export function serveStatic(dir: string | null, pathname: string): Promise<Response> | Response {
  if (dir === null) return new Response("not found", { status: 404 });
  // Reject traversal before touching the filesystem.
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
  const target = rel === "" ? "index.html" : rel;
  return (async () => {
    const file = Bun.file(join(dir, target));
    if (await file.exists()) return new Response(file);
    const index = Bun.file(join(dir, "index.html"));
    if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  })();
}
