import { deref } from "./schema.ts";

// Just enough OpenAPI typing for the endpoint list.
export interface Parameter {
  name: string;
  in: "query" | "header" | "path" | "cookie";
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: unknown;
  content?: Record<string, { schema?: unknown }>;
}

export interface RequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: unknown }>;
}

export interface Header {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: unknown;
  content?: Record<string, { schema?: unknown }>;
}

export interface Response {
  description?: string;
  headers?: Record<string, unknown>;
  content?: Record<string, { schema?: unknown }>;
}

export interface Operation {
  operationId?: string;
  responses?: Record<string, unknown>;
  parameters?: unknown[];
  requestBody?: unknown;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
}

export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string; description?: string };
  tags?: { name: string; description?: string }[];
  paths?: Record<string, Record<string, unknown>>;
}

export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface Endpoint {
  method: HttpMethod;
  path: string;
  op: Operation;
  /** Parameters declared on the path item, shared by all its operations. */
  pathParameters?: unknown[];
}

export interface EndpointGroup {
  tag: string;
  description?: string;
  endpoints: Endpoint[];
}

export function listEndpoints(doc: OpenApiDoc): Endpoint[] {
  const out: Endpoint[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method] as Operation | undefined;
      if (op) out.push({ method, path, op, pathParameters: item.parameters as unknown[] | undefined });
    }
  }
  return out;
}

/** Alphabetical by path; same path ordered by HTTP method (GET, PUT, POST, …). */
export function compareEndpoints(a: Endpoint, b: Endpoint): number {
  return a.path.localeCompare(b.path) || HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method);
}

/** Group endpoints by their first tag, in the order of the document's `tags` list. */
export function groupByTag(doc: OpenApiDoc): EndpointGroup[] {
  const groups = new Map<string, EndpointGroup>();
  for (const t of doc.tags ?? []) groups.set(t.name, { tag: t.name, description: t.description, endpoints: [] });
  for (const ep of listEndpoints(doc)) {
    const tag = ep.op.tags?.[0] ?? "default";
    if (!groups.has(tag)) groups.set(tag, { tag, endpoints: [] });
    groups.get(tag)!.endpoints.push(ep);
  }
  for (const g of groups.values()) g.endpoints.sort(compareEndpoints);
  return [...groups.values()].filter((g) => g.endpoints.length > 0);
}

/** URL anchor for an endpoint, e.g. "get/api/vehicles/{id}". Method + path is unique within a document. */
export function endpointAnchor(ep: Endpoint): string {
  return ep.method + ep.path;
}

/** Effective parameters: path-item ones, overridden by operation ones with the same name + location. */
export function effectiveParameters(doc: OpenApiDoc, ep: Endpoint): Parameter[] {
  const byKey = new Map<string, Parameter>();
  for (const raw of [...(ep.pathParameters ?? []), ...(ep.op.parameters ?? [])]) {
    const p = deref<Parameter>(doc, raw).value;
    if (p?.name && p.in) byKey.set(`${p.in}:${p.name}`, p);
  }
  return [...byKey.values()];
}

export function requestBody(doc: OpenApiDoc, ep: Endpoint): RequestBody | undefined {
  return ep.op.requestBody ? deref<RequestBody>(doc, ep.op.requestBody).value : undefined;
}

/** Responses by status code, sorted: 1XX…5XX numerically (ranges like "4XX" after their codes), "default" last. */
export function responses(doc: OpenApiDoc, ep: Endpoint): { status: string; response: Response }[] {
  const rank = (s: string) => (s === "default" ? 1000 : Number(s.replace(/X/gi, "9")) || 999);
  return Object.entries(ep.op.responses ?? {})
    .map(([status, raw]) => ({ status, response: deref<Response>(doc, raw).value }))
    .sort((a, b) => rank(a.status) - rank(b.status));
}

/** Response headers, dereferenced. `Content-Type` is ignored, as the spec requires. */
export function responseHeaders(doc: OpenApiDoc, r: Response): { name: string; header: Header }[] {
  return Object.entries(r.headers ?? {})
    .filter(([name]) => name.toLowerCase() !== "content-type")
    .map(([name, raw]) => ({ name, header: deref<Header>(doc, raw).value }));
}

/** Schema of a parameter or header: `schema`, or the first media type of `content`. */
export function parameterSchema(p: Parameter | Header): unknown {
  return p.schema ?? Object.values(p.content ?? {})[0]?.schema;
}
