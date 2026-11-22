// Builds an example JSON value for a body: the spec's own example when there is one,
// otherwise one assembled from the schema (property examples, defaults, enums, formats…).
import { deref, discriminatorValues, itemsOf, toNode, type Direction, type SchemaNode } from "./schema.ts";

interface Media {
  schema?: unknown;
  example?: unknown;
  examples?: Record<string, unknown>;
}

/** Example for a media type object (request or response body). */
export function mediaExample(doc: unknown, media: Media, direction: Direction, exclude: ReadonlySet<string> = new Set()): unknown {
  const node = toNode(doc, media.schema);
  let value = specExample(doc, media) ?? exampleOf(doc, node, direction, []);
  // In a request, an optional property whose value is its default needn't be sent.
  if (direction === "request") value = withoutDefaults(doc, node, value, []);
  // Top-level properties already sent as path or query parameters are left out, as in the Fields view.
  if (value && typeof value === "object" && !Array.isArray(value) && exclude.size > 0) {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !exclude.has(k)));
  }
  return value;
}

/** The media type's own `example`, or the first of its `examples` (Example objects, possibly $ref'd). */
function specExample(doc: unknown, media: Media): unknown {
  if (media.example !== undefined) return media.example;
  for (const raw of Object.values(media.examples ?? {})) {
    const ex = deref<{ value?: unknown }>(doc, raw).value;
    if (ex?.value !== undefined) return ex.value;
  }
  return undefined;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Trims a request example, at any depth: removes the optional properties whose value equals their
 * default, and keeps only `minProperties` properties where a minimum is set. Works on generated examples
 * and on examples written in the spec alike.
 */
function withoutDefaults(doc: unknown, node: SchemaNode, value: unknown, ancestors: string[]): unknown {
  if (node.ref && ancestors.includes(node.ref)) return value;
  const inner = node.ref ? [...ancestors, node.ref] : ancestors;
  if (node.variants) {
    const option = matchingVariant(doc, node, value);
    return option ? withoutDefaults(doc, option, value, inner) : value;
  }
  if (Array.isArray(value)) {
    const items = itemsOf(doc, node);
    return items ? value.map((v) => withoutDefaults(doc, items, v, inner)) : value;
  }
  const props = node.schema.properties;
  if (!value || typeof value !== "object" || !props) return value;
  const required = new Set<string>(node.schema.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (props[key] === undefined) {
      out[key] = v;
      continue;
    }
    const child = toNode(doc, props[key]);
    const d = child.schema.default;
    if (d !== undefined && !required.has(key) && same(v, d)) continue;
    out[key] = withoutDefaults(doc, child, v, inner);
  }
  // An object that needs "at least N properties" (e.g. one of several optional ones) shows just N:
  // the required ones first, then the first declared.
  const min = node.schema.minProperties;
  if (typeof min === "number" && min >= 1) {
    const keys = Object.keys(out);
    const keep = [...new Set([...keys.filter((k) => required.has(k)), ...keys])].slice(0, Math.max(min, required.size));
    return Object.fromEntries(keep.map((k) => [k, out[k]]));
  }
  return out;
}

/** The alternative of a oneOf/anyOf that an example value belongs to, if it can be told. */
function matchingVariant(doc: unknown, node: SchemaNode, value: unknown): SchemaNode | undefined {
  const options = node.variants!.nodes;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const disc = discriminatorValues(doc, node);
  if (disc) {
    const v = obj[disc.property];
    const i = v === undefined ? disc.defaultIndex ?? -1 : disc.values.indexOf(JSON.stringify(v));
    if (i >= 0) return options[i];
  }
  // Otherwise the first object alternative that declares every key of the value.
  return options.find((o) => o.schema.properties && Object.keys(obj).every((k) => k in o.schema.properties));
}

/** Placeholder for a string, from its format. */
const STRING_FORMATS: Record<string, string> = {
  date: "2024-01-31",
  "date-time": "2024-01-31T12:00:00Z",
  time: "12:00:00",
  email: "user@example.com",
  uri: "https://example.com",
  url: "https://example.com",
  uuid: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  hostname: "example.com",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
};

function exampleOf(doc: unknown, node: SchemaNode, direction: Direction, ancestors: string[]): unknown {
  const s = node.schema;
  // Values the spec gives win over anything made up.
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0];
  if (s.const !== undefined) return s.const;
  if (s.default !== undefined && s.default !== null) return s.default;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum.find((v: unknown) => v !== null) ?? s.enum[0];

  // Recursive schema: stop here rather than loop forever.
  if (node.ref && ancestors.includes(node.ref)) return node.types.includes("array") ? [] : {};
  const inner = node.ref ? [...ancestors, node.ref] : ancestors;

  if (node.variants) {
    // The alternative used when the discriminator is missing, else the first one.
    const pick = discriminatorValues(doc, node)?.defaultIndex ?? 0;
    const option = node.variants.nodes[pick];
    return option ? exampleOf(doc, option, direction, inner) : null;
  }

  const items = itemsOf(doc, node);
  if (items) return [exampleOf(doc, items, direction, inner)];

  if (node.types.includes("object") || s.properties) {
    const out: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries<unknown>(s.properties ?? {})) {
      const child = toNode(doc, raw);
      // Same rule as the Fields view: readOnly is not sent, writeOnly is not returned.
      if (direction === "request" ? child.schema.readOnly : child.schema.writeOnly) continue;
      out[name] = exampleOf(doc, child, direction, inner);
    }
    return out;
  }

  const type = node.types[0];
  if (type === "string" || (type === undefined && typeof s.format === "string")) {
    return STRING_FORMATS[s.format] ?? "string";
  }
  if (type === "integer" || type === "number") {
    if (typeof s.minimum === "number") return s.minimum;
    if (typeof s.exclusiveMinimum === "number") return type === "integer" ? s.exclusiveMinimum + 1 : s.exclusiveMinimum + 0.5;
    if (typeof s.maximum === "number") return Math.min(0, s.maximum);
    return 0;
  }
  if (type === "boolean") return true;
  return null; // any, or only null
}
