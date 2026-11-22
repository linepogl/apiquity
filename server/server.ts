// Minimal web server:
//   GET /                   -> a page with the <apiquity-ui> element, pointed at the spec files
//   GET /apiquity.js        -> the web component (dist/apiquity.js)
//   GET /spec/<file name>   -> a spec file given on the command line, as is
//
// Usage: node server/server.ts spec-file [spec-file] [--port N]
//   One or two files: at most one OpenAPI and one AsyncAPI document, JSON or YAML; each file's kind is
//   read from its content.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
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

/** OpenAPI or AsyncAPI, from the document's top-level `openapi:` / `asyncapi:` key (JSON or YAML). */
function kindOf(file: string): Kind {
  const head = readFileSync(file, "utf8").slice(0, 4096);
  const m = /^\s*["']?(openapi|asyncapi)["']?\s*:/m.exec(head);
  if (!m) fail(`${file}: neither an OpenAPI nor an AsyncAPI document (no top-level "openapi" or "asyncapi" key)`);
  return m[1] as Kind;
}

if (positionals.length === 0) fail("No spec file. Pass one or two files: one OpenAPI and/or one AsyncAPI.");
if (positionals.length > 2) fail("At most two spec files: one OpenAPI and one AsyncAPI.");
const files = positionals.map((f) => resolve(f));

const specs: Partial<Record<Kind, string>> = {};
for (const file of files) {
  if (!existsSync(file)) fail(`Not found: ${file}`);
  const kind = kindOf(file);
  if (specs[kind]) fail(`Two ${kind} files: ${specs[kind]} and ${file}. Pass at most one of each.`);
  specs[kind] = file;
}
if (specs.openapi && specs.asyncapi && basename(specs.openapi) === basename(specs.asyncapi)) {
  fail(`Both files are named ${basename(specs.openapi)}: they are served by name, so rename one.`);
}

// YAML is served as text so that browsers display it instead of downloading it.
const rawTypes: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
};

/** URL path of a spec file. */
const specPath = (file: string) => `/spec/${encodeURIComponent(basename(file))}`;

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
      // Files are read on every request, so edits show up on reload.
      const file = Object.values(specs).find((f) => specPath(f) === path);
      if (!file) send(res, 404, "text/plain; charset=utf-8", "No such spec");
      else send(res, 200, rawTypes[extname(file).toLowerCase()] ?? "text/plain; charset=utf-8", await readFile(file));
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
