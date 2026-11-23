// Turns raw (possibly $ref'd) JSON Schemas into a view model for display.
// Handles OpenAPI 3.0 (`nullable`) and 3.1 (`type: [..., "null"]`, `oneOf: [X, {type: "null"}]`).

export type JsonSchema = { [key: string]: any };

/** Resolve a local JSON pointer such as "#/components/schemas/Foo". */
export function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined; // external refs not supported
  let cur: any = doc;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Follow a chain of $refs. Sibling keywords next to a $ref (allowed in 3.1) override the target's. */
export function deref<T = JsonSchema>(doc: unknown, obj: any): { value: T; ref?: string; missing?: string } {
  let ref: string | undefined;
  const seen = new Set<string>();
  let overrides: JsonSchema = {};
  while (obj && typeof obj === "object" && typeof obj.$ref === "string") {
    const r: string = obj.$ref;
    if (seen.has(r)) break;
    seen.add(r);
    const { $ref: _, ...siblings } = obj;
    overrides = { ...siblings, ...overrides };
    ref = r;
    const target = resolvePointer(doc, r);
    if (target === undefined) return { value: overrides as T, ref, missing: r };
    obj = target;
  }
  return { value: { ...obj, ...overrides } as T, ref };
}

/** Display name for a $ref: last pointer segment, without generated hash suffixes like "-D7F306E5" or "__7AC3E3CC". */
export function refName(ref: string): string {
  return withoutHashSuffix(ref.split("/").pop()!);
}

/** Removes a generated hash suffix: "offer-id-3F975A50" -> "offer-id", "CriteriaConditionFilter__7AC3E3CC" -> "CriteriaConditionFilter". */
export function withoutHashSuffix(name: string): string {
  return name.replace(/(?:-|__)[0-9A-F]{8}$/, "");
}

export interface SchemaNode {
  schema: JsonSchema;
  /** Name of the referenced component, if any. */
  typeName?: string;
  /** Full $ref of the component, used for cycle detection. */
  ref?: string;
  /** Non-null JSON types. */
  types: string[];
  nullable: boolean;
  /** Alternatives left after removing the `null` option from oneOf/anyOf. */
  variants?: { kind: "oneOf" | "anyOf"; nodes: SchemaNode[] };
  missingRef?: string;
  /** Tab label when the node is an alternative without a title or component name, e.g. "object". */
  label?: string;
}

const isNullSchema = (s: any) => s && typeof s === "object" && (s.type === "null" || (Array.isArray(s.type) && s.type.length === 1 && s.type[0] === "null"));

export function toNode(doc: unknown, raw: unknown): SchemaNode {
  return singleValueEnumAsConst(buildNode(doc, raw));
}

/**
 * An enum with a single value (ignoring `null`) is a constant: shown as `const`, with its value next to
 * the property name. A `null` among the values makes it nullable.
 */
function singleValueEnumAsConst(node: SchemaNode): SchemaNode {
  const { enum: values, ...rest } = node.schema;
  if (!Array.isArray(values) || rest.const !== undefined) return node;
  const nonNull = values.filter((v) => v !== null);
  if (nonNull.length !== 1) return node;
  return { ...node, schema: { ...rest, const: nonNull[0] }, nullable: node.nullable || nonNull.length < values.length };
}

function buildNode(doc: unknown, raw: unknown): SchemaNode {
  if (raw === true || raw === undefined) return { schema: {}, types: [], nullable: false };
  if (raw === false) return { schema: { not: {} }, types: ["never"], nullable: false };

  const { value: s, ref, missing } = deref(doc, raw);
  let typeName = ref ? refName(ref) : undefined;
  let nullable = s.nullable === true;
  let types: string[] = Array.isArray(s.type) ? [...s.type] : s.type ? [s.type] : [];
  if (types.includes("null")) {
    nullable = true;
    types = types.filter((t) => t !== "null");
  }
  if (types.length === 0 && s.properties) types = ["object"];
  if (types.length === 0 && s.items) types = ["array"];

  const kind = s.oneOf ? "oneOf" : s.anyOf ? "anyOf" : undefined;
  if (kind) {
    const options: unknown[] = s[kind];
    const nonNull = options.filter((o) => !isNullSchema(deref(doc, o).value));
    if (nonNull.length < options.length) nullable = true;
    const { [kind]: _, ...outer } = s;
    if (nonNull.length === 1 && types.length === 0) {
      // `oneOf: [X, null]` -> X, nullable. Outer keywords (description, default…) win.
      const inner = toNode(doc, nonNull[0]);
      const merged: SchemaNode = {
        ...inner,
        schema: { ...inner.schema, ...stripUndefined(outer) },
        typeName: inner.typeName ?? typeName,
        ref: inner.ref ?? ref,
        nullable: true,
      };
      return splitByType(merged, kind);
    }
    return {
      schema: outer,
      typeName,
      ref,
      types,
      nullable,
      variants: { kind, nodes: nonNull.map((o) => toNode(doc, o)) },
      missingRef: missing,
    };
  }
  if (s.allOf) {
    // Merge allOf parts (good enough for display: properties and required are combined).
    const parts = (s.allOf as unknown[]).map((p) => toNode(doc, p));
    const merged: JsonSchema = { ...s };
    delete merged.allOf;
    for (const p of parts) {
      for (const [k, v] of Object.entries(p.schema)) {
        if (k === "properties") merged.properties = { ...v, ...merged.properties };
        else if (k === "required") merged.required = [...new Set([...(merged.required ?? []), ...v])];
        else if (!(k in merged)) merged[k] = v;
      }
      if (types.length === 0) types = p.types;
      if (p.nullable) nullable = true;
      typeName ??= parts.length === 1 ? p.typeName : undefined;
    }
    if (types.length === 0 && merged.properties) types = ["object"];
    return { schema: merged, typeName, ref, types, nullable };
  }
  return { schema: s, typeName, ref, types, nullable, missingRef: missing };
}

/**
 * A oneOf/anyOf alternative that allows several JSON types, e.g. `oneOf: [{type: [object, array]}, null]`,
 * is still a choice: one tab per type (object, array), the node itself staying nullable.
 */
function splitByType(node: SchemaNode, kind: "oneOf" | "anyOf"): SchemaNode {
  if (node.variants || node.types.length < 2) return node;
  // Keywords about the value as a whole stay on the node; each tab keeps the rest, with its one type.
  const { title: _t, description: _d, default: _df, examples: _e, example: _ex, $id: _id, ...rest } = node.schema;
  const nodes = node.types.map((t): SchemaNode => ({ schema: { ...rest, type: t }, types: [t], nullable: false, label: t }));
  return { ...node, types: [], variants: { kind, nodes } };
}

function stripUndefined(o: JsonSchema): JsonSchema {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export interface ChildRow {
  label: string;
  node: SchemaNode;
  required?: boolean;
  /** Displayed instead of a property name, e.g. "option 1" or "...". */
  synthetic?: boolean;
  /** Shown instead of the schema's own description. */
  description?: string;
  /** Starts expanded, e.g. the content of a message envelope. */
  defaultOpen?: boolean;
  /** Part of a message envelope (metadata around the content): shown dimmed. */
  envelope?: boolean;
}

/**
 * Rows shown when a node is expanded.
 * Properties that don't travel in this direction are hidden: `readOnly` ones in requests, `writeOnly` ones in responses.
 */
export type Direction = "request" | "response";

export function childrenOf(doc: unknown, node: SchemaNode, direction: Direction = "request"): ChildRow[] {
  // Alternatives (oneOf/anyOf) are rendered as tabs, not rows.
  if (node.variants) return [];
  const s = node.schema;
  // Arrays have no rows of their own: their items are rendered separately (see itemsOf).
  if (node.types.includes("array")) return [];
  // Nothing is known about the keys: rendered as `{ any }` rather than as rows (see isUnknownObject).
  if (isUnknownObject(node)) return [];
  const rows: ChildRow[] = [];
  const required = new Set<string>(s.required ?? []);
  for (const [name, prop] of Object.entries<unknown>(s.properties ?? {})) {
    const child = toNode(doc, prop);
    if (direction === "request" ? child.schema.readOnly : child.schema.writeOnly) continue;
    rows.push({ label: name, node: child, required: required.has(name) });
  }
  // Extra keys are only worth showing in requests: they tell the client what else it may send.
  if (direction === "request" && allowsAdditionalProperties(node)) {
    const extra = s.additionalProperties;
    const node = toNode(doc, typeof extra === "object" ? extra : true);
    // Keep the value schema's own description, if any, after the explanation.
    const description = ["This object accepts additional attributes.", node.schema.description].filter(Boolean).join("\n\n");
    rows.push({ label: "...", node, synthetic: true, description });
  }
  return rows;
}

/**
 * An object that says nothing about its keys or values: no properties, no key patterns, and any
 * additional value allowed. Rendered as `{ any }`, the way an array without items reads `[ any ]`.
 */
export function isUnknownObject(node: SchemaNode): boolean {
  const s = node.schema;
  if (node.variants || node.types.length !== 1 || node.types[0] !== "object") return false;
  if (Object.keys(s.properties ?? {}).length > 0 || s.patternProperties || s.propertyNames) return false;
  if (s.unevaluatedProperties === false) return false;
  const extra = s.additionalProperties;
  return extra === undefined || extra === true || (typeof extra === "object" && extra !== null && Object.keys(extra).length === 0);
}

/**
 * Whether an object accepts keys beyond its declared properties. In JSON Schema that is the
 * default: only `additionalProperties: false` (or `unevaluatedProperties: false`) forbids them.
 */
function allowsAdditionalProperties(node: SchemaNode): boolean {
  const s = node.schema;
  if (!node.types.includes("object")) return false;
  return s.additionalProperties !== false && s.unevaluatedProperties !== false;
}

/** Short type text such as "string", "enum", "date-string", "array", "object|null". */
export function typeSummary(doc: unknown, node: SchemaNode): string {
  const base = baseType(node);
  return node.nullable && base !== "any" ? `${base}|null` : base;
}

/** A plain string (no format, no enum) that must not be empty: its type reads "non-empty-string" instead of a chip. */
function isNonEmptyString(node: SchemaNode): boolean {
  const s = node.schema;
  if (node.variants || Array.isArray(s.enum) || s.minLength !== 1 || typeof s.format === "string") return false;
  return node.types.length === 1 && node.types[0] === "string";
}

/** A formatted string (uri, date…) is never empty, so `minLength: 1` adds nothing. */
const isFormattedString = (node: SchemaNode) =>
  typeof node.schema.format === "string" && (node.types.length === 0 || (node.types.length === 1 && node.types[0] === "string"));

/** An array that must hold at least one item: its type reads "non-empty-array" instead of a chip. */
const isNonEmptyArray = (node: SchemaNode) =>
  !node.variants && node.types.length === 1 && node.types[0] === "array" && node.schema.minItems === 1;

function baseType(node: SchemaNode): string {
  const type = rawBaseType(node);
  return isNonEmptyString(node) || isNonEmptyArray(node) ? `non-empty-${type}` : type;
}

function rawBaseType(node: SchemaNode): string {
  const s = node.schema;
  if (node.variants) return node.variants.kind;
  // The item type is shown inside the [ … ] block when the row is opened. Several types
  // (e.g. object|array) fall through to the list of types below.
  if (node.types.length === 1 && node.types[0] === "array") return "array";
  // A single possible value (shown next to the name): its JSON type adds nothing.
  if (s.const !== undefined) return "const";
  // The allowed values are listed below the row, so the underlying JSON type adds nothing.
  if (Array.isArray(s.enum)) return "enum";
  // A format is more specific than its JSON type, so it replaces it. String formats keep a "-string"
  // suffix (date-string, uri-string…) to make clear the value travels as a JSON string.
  if (typeof s.format === "string") {
    return node.types.length === 0 || node.types.includes("string") ? `${s.format}-string` : s.format;
  }
  return node.types.join("|") || (s.const !== undefined ? "const" : "any");
}

/** Validation keywords rendered as compact chips. */
export function constraints(node: SchemaNode): string[] {
  const s = node.schema;
  const out: string[] = [];
  const excl = (v: unknown) => typeof v === "number";
  if (s.minimum !== undefined) out.push(s.exclusiveMinimum === true ? `> ${s.minimum}` : `≥ ${s.minimum}`);
  if (excl(s.exclusiveMinimum)) out.push(`> ${s.exclusiveMinimum}`);
  if (s.maximum !== undefined) out.push(s.exclusiveMaximum === true ? `< ${s.maximum}` : `≤ ${s.maximum}`);
  if (excl(s.exclusiveMaximum)) out.push(`< ${s.exclusiveMaximum}`);
  if (s.multipleOf !== undefined) out.push(`multiple of ${s.multipleOf}`);
  if (s.minLength === 1) {
    // Already in the type ("non-empty-string") or implied by the format.
    if (!isNonEmptyString(node) && !isFormattedString(node)) out.push("non-empty");
  }
  else if (s.minLength !== undefined) out.push(`length ≥ ${s.minLength}`);
  if (s.maxLength !== undefined) out.push(`length ≤ ${s.maxLength}`);
  if (s.pattern !== undefined) out.push(`/${s.pattern}/`);
  if (s.minItems === 1) {
    if (!isNonEmptyArray(node)) out.push("non-empty"); // otherwise already in the type
  }
  else if (s.minItems !== undefined) out.push(`items ≥ ${s.minItems}`);
  if (s.maxItems !== undefined) out.push(`items ≤ ${s.maxItems}`);
  if (s.uniqueItems) out.push("unique");
  // Spelled out even for 1: "non-empty" is easy to miss on an object.
  if (s.minProperties !== undefined) out.push(`properties ≥ ${s.minProperties}`);
  if (s.maxProperties !== undefined) out.push(`properties ≤ ${s.maxProperties}`);
  return out;
}

/** Item schema of an array node, if any. */
export function itemsOf(doc: unknown, node: SchemaNode): SchemaNode | undefined {
  return node.types.includes("array") && !node.variants ? toNode(doc, node.schema.items) : undefined;
}

/** Tab label for an alternative: its title, its component name, or its position. */
/**
 * Value of the discriminator property for each alternative of a oneOf/anyOf with a `discriminator`,
 * e.g. { property: "type", values: ['"photo"', '"youtube"', '"video"'] }. Undefined when there is no
 * discriminator or when any alternative's value can't be found.
 */
export function discriminatorValues(
  doc: unknown,
  node: SchemaNode,
): { property: string; values: string[]; defaultIndex?: number } | undefined {
  // OpenAPI: `{ propertyName, mapping?, defaultMapping? }`. AsyncAPI (and JSON Schema dialects that
  // follow it): just the property name, `discriminator: type`.
  const raw = node.schema.discriminator;
  const d = typeof raw === "string" ? { propertyName: raw } : raw;
  if (!node.variants || typeof d?.propertyName !== "string") return undefined;
  const property: string = d.propertyName;
  const mapping: Record<string, string> = d.mapping ?? {};
  const values = node.variants.nodes.map((v) => {
    // 1. The mapping: value -> $ref of the alternative.
    const mapped = Object.entries(mapping).find(([, ref]) => ref === v.ref)?.[0];
    if (mapped !== undefined) return JSON.stringify(mapped);
    // 2. The alternative's own property: a const or a single-value enum, possibly in nested alternatives.
    return propertyValue(doc, v, property);
  });
  if (!values.every((v) => v !== undefined)) return undefined;
  // The alternative picked when the property is missing or matches no mapping: `defaultMapping`.
  const index = typeof d.defaultMapping === "string" ? node.variants.nodes.findIndex((v) => v.ref === d.defaultMapping) : -1;
  return { property, values: values as string[], defaultIndex: index >= 0 ? index : undefined };
}

/**
 * The single value an alternative gives a property, as JSON: from its own const or single-value enum,
 * or else from its own alternatives when they all agree (e.g. a `photo` alternative that is itself a
 * oneOf of interior, exterior and other photos, each with `type: photo`).
 */
function propertyValue(doc: unknown, node: SchemaNode, property: string, depth = 0): string | undefined {
  const prop = node.schema.properties?.[property];
  if (prop !== undefined) {
    const p = toNode(doc, prop).schema;
    if (p.const !== undefined) return JSON.stringify(p.const);
    if (Array.isArray(p.enum) && p.enum.length === 1) return JSON.stringify(p.enum[0]);
  }
  if (!node.variants || depth > 8) return undefined;
  const values = new Set(node.variants.nodes.map((n) => propertyValue(doc, n, property, depth + 1)));
  const [value] = values;
  return values.size === 1 ? value : undefined;
}

/** Marks a property that may be left out because the discriminator's `defaultMapping` picks its alternative then. */
export const DEFAULT_MAPPING_MARK = "x-viewer-default-mapping";

/**
 * The `defaultMapping` alternative as seen by a reader: its discriminator property may be left out and
 * then defaults to the alternative's value. Returns a copy with the property optional, defaulted and marked.
 */
export function withDiscriminatorDefault(doc: unknown, node: SchemaNode, property: string, value: string): SchemaNode {
  const prop = node.schema.properties?.[property];
  if (prop === undefined) return node;
  const { value: resolved } = deref(doc, prop);
  return {
    ...node,
    schema: {
      ...node.schema,
      required: (node.schema.required ?? []).filter((r: string) => r !== property),
      properties: { ...node.schema.properties, [property]: { ...resolved, default: JSON.parse(value), [DEFAULT_MAPPING_MARK]: true } },
    },
  };
}

export function variantLabel(node: SchemaNode, index: number): string {
  return node.schema.title ?? node.typeName ?? node.label ?? `option ${index + 1}`;
}

/** Whether a node has anything to show below its own details. */
export function hasNested(doc: unknown, node: SchemaNode, direction: Direction = "request"): boolean {
  return !!node.variants || itemsOf(doc, node) !== undefined || isUnknownObject(node) || childrenOf(doc, node, direction).length > 0;
}

/**
 * The schema as JSON, with local $refs replaced by their targets so it reads on its own.
 * A $ref that points back to one of its ancestors (recursion) or can't be resolved is kept as is.
 */
export function inlineRefs(doc: unknown, value: unknown, ancestors: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => inlineRefs(doc, v, ancestors));
  if (!value || typeof value !== "object") return value;
  const { $ref: ref, ...siblings } = value as JsonSchema;
  if (typeof ref === "string" && !ancestors.includes(ref)) {
    const target = resolvePointer(doc, ref);
    if (target !== undefined) {
      const inner = inlineRefs(doc, target, [...ancestors, ref]);
      // Keywords next to a $ref (allowed in 3.1) override the target's.
      return Object.keys(siblings).length > 0 && inner && typeof inner === "object"
        ? { ...inner, ...(inlineRefs(doc, siblings, ancestors) as JsonSchema) }
        : inner;
    }
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inlineRefs(doc, v, ancestors)]));
}

/** Top-level rows of a body, minus the properties whose names are in `exclude` (e.g. already sent as parameters). */
export function bodyRows(doc: unknown, node: SchemaNode, direction: Direction, exclude: ReadonlySet<string>): ChildRow[] {
  return childrenOf(doc, node, direction).filter((r) => r.synthetic || !exclude.has(r.label));
}

/**
 * Whether a body has nothing left to send once the `exclude`d properties are removed: a plain object
 * with no other property. A map (`additionalProperties` with a schema), an array or alternatives are never empty.
 */
export function isEmptyBody(doc: unknown, node: SchemaNode, direction: Direction, exclude: ReadonlySet<string>): boolean {
  if (node.variants || !node.types.includes("object") || itemsOf(doc, node)) return false;
  if (typeof node.schema.additionalProperties === "object") return false;
  return bodyRows(doc, node, direction, exclude).every((r) => r.synthetic);
}
