// Minimal web server:
//   GET /                   -> a page with the <apiquity-ui> element, pointed at the spec files
//   GET /apiquity.js        -> the web component (dist/apiquity.js)
//   GET /spec/<file name>   -> a spec given on the command line, as is
//
// Usage: node server/server.ts spec [spec] [--port N]
//   One or two specs: at most one OpenAPI and one AsyncAPI document, JSON or YAML; each one's kind is
//   read from its content. A spec is a file, or an http(s) URL that the server fetches (so the page
//   needs no CORS from it).
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { parseArgs } from "node:util";

type Kind = "openapi" | "asyncapi";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string", default: process.env.PORT ?? "8080" } },
});

const root = resolve(import.meta.dirname, "..");
const componentFile = resolve(root, "dist/apiquity.js");
const port = Number(values.port);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const isUrl = (spec: string) => /^https?:\/\//i.test(spec);

/** A spec's content: the file, read again, or the URL, fetched again (so edits show up on reload). */
async function read(spec: string): Promise<Buffer> {
  if (!isUrl(spec)) return readFile(spec);
  const res = await fetch(spec);
  if (!res.ok) throw new Error(`${spec}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/** A spec's file name: the file's, or the last segment of the URL's path. */
const nameOf = (spec: string) => basename(isUrl(spec) ? decodeURIComponent(new URL(spec).pathname) : spec);

/** OpenAPI or AsyncAPI, from the document's top-level `openapi:` / `asyncapi:` key (JSON or YAML). */
async function kindOf(file: string): Promise<Kind> {
  let text: string;
  try {
    text = (await read(file)).toString("utf8");
  } catch (e) {
    fail(`Can't read ${file}: ${(e as Error).message}`);
  }
  // JSON, even minified: its keys. Otherwise YAML: a top-level key at the start of a line.
  let keys: string[] = [];
  try {
    const doc = JSON.parse(text);
    if (doc && typeof doc === "object") keys = Object.keys(doc);
  } catch {
    const m = /^\s*["']?(openapi|asyncapi)["']?\s*:/m.exec(text.slice(0, 4096));
    if (m) keys = [m[1]];
  }
  const kind = (["openapi", "asyncapi"] as const).find((k) => keys.includes(k));
  if (!kind) fail(`${file}: neither an OpenAPI nor an AsyncAPI document (no top-level "openapi" or "asyncapi" key)`);
  return kind;
}

if (positionals.length === 0) fail("No spec. Pass one or two files or URLs: one OpenAPI and/or one AsyncAPI.");
if (positionals.length > 2) fail("At most two specs: one OpenAPI and one AsyncAPI.");
const files = positionals.map((f) => (isUrl(f) ? f : resolve(f)));

const specs: Partial<Record<Kind, string>> = {};
for (const file of files) {
  if (!isUrl(file) && !existsSync(file)) fail(`Not found: ${file}`);
  const kind = await kindOf(file);
  if (specs[kind]) fail(`Two ${kind} files: ${specs[kind]} and ${file}. Pass at most one of each.`);
  specs[kind] = file;
}
if (specs.openapi && specs.asyncapi && nameOf(specs.openapi) === nameOf(specs.asyncapi)) {
  fail(`Both specs are named ${nameOf(specs.openapi)}: they are served by name, so rename one.`);
}

// YAML is served as text so that browsers display it instead of downloading it.
const rawTypes: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
};

/** URL path of a spec file. */
const specPath = (file: string) => `/spec/${encodeURIComponent(nameOf(file))}`;

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The page: the component, full-window, with the selection in the URL hash. */
const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Apiquity</title>
    <style>body { margin: 0; }</style>
    <script type="module" src="/apiquity.js"></script>
  </head>
  <body>
    <apiquity-ui routing="hash"${Object.entries(specs)
      .map(([kind, file]) => ` ${kind}="${escapeAttr(specPath(file))}"`)
      .join("")}></apiquity-ui>
  </body>
</html>
`;

function send(res: import("node:http").ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache" }).end(body);
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
    } else if (path.startsWith("/spec/")) {
      // Specs are read (or fetched) on every request, so edits show up on reload.
      const file = Object.values(specs).find((f) => specPath(f) === path);
      if (!file) send(res, 404, "text/plain; charset=utf-8", "No such spec");
      else send(res, 200, rawTypes[extname(nameOf(file)).toLowerCase()] ?? "text/plain; charset=utf-8", await read(file));
    } else if (path === "/apiquity.js") {
      send(res, 200, "text/javascript; charset=utf-8", await readFile(componentFile));
    } else {
      // Any other path serves the page.
      send(res, 200, "text/html; charset=utf-8", page);
    }
  } catch (e) {
    send(res, 500, "text/plain; charset=utf-8", `Error: ${(e as Error).message}`);
  }
}).listen(port, () => {
  console.log(`API viewer on http://localhost:${port}`);
  for (const [kind, file] of Object.entries(specs)) console.log(`  ${kind}: ${file}`);
});
