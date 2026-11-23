import { Text } from "./Text.tsx";
import { formatJson } from "./json.ts";
import { createContext, type ComponentChildren } from "preact";
import { useContext, useState } from "preact/hooks";
import {
  bodyRows,
  childrenOf,
  constraints,
  hasNested,
  isUnknownObject,
  itemsOf,
  toNode,
  typeSummary,
  variantLabel,
  DEFAULT_MAPPING_MARK,
  discriminatorValues,
  withDiscriminatorDefault,
  type ChildRow,
  type Direction,
  type SchemaNode,
} from "./schema.ts";

/** Whether the schemas below describe a request or a response (affects readOnly / writeOnly properties). */
export const DirectionContext = createContext<Direction>("request");

/**
 * Horizontal tabs; `render` draws the panel of the selected tab.
 * Uncontrolled by default; pass `selected` + `onSelect` to control it (e.g. from the URL).
 */
export function Tabs({
  labels,
  tabClass,
  render,
  className,
  selected: controlled,
  onSelect,
}: {
  className?: string;
  labels: ComponentChildren[];
  tabClass?: (i: number) => string;
  render: (i: number) => ComponentChildren;
  selected?: number;
  onSelect?: (i: number) => void;
}) {
  const [own, setOwn] = useState(0);
  const selected = controlled ?? own;
  const setSelected = onSelect ?? setOwn;
  return (
    <div class={className ?? "variants"}>
      <div class="tabs" role="tablist">
        {labels.map((label, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === selected}
            class={`tab${i === selected ? " active" : ""} ${tabClass?.(i) ?? ""}`}
            onClick={() => setSelected(i)}
          >
            {label}
          </button>
        ))}
      </div>
      <div class="tab-panel" role="tabpanel" key={selected}>
        {render(selected)}
      </div>
    </div>
  );
}

/** Format a JSON value compactly for display. */
const show = (v: unknown) => JSON.stringify(v) ?? String(v);

const exampleOf = (s: SchemaNode["schema"]) => s.example ?? (Array.isArray(s.examples) ? s.examples[0] : undefined);

/** Defaults describe what the server assumes for a missing input; they mean nothing in a response. */
/** Except a discriminator's `defaultMapping` default: it says how any payload without the property is read. */
const showsDefault = (s: SchemaNode["schema"], direction: Direction) =>
  s.default !== undefined && (direction === "request" || s[DEFAULT_MAPPING_MARK] === true);

function hasDetails(node: SchemaNode, direction: Direction, description?: string): boolean {
  const s = node.schema;
  return (
    !!(description ?? s.description) ||
    !!s.enum ||
    s.const !== undefined ||
    showsDefault(s, direction) ||
    exampleOf(s) !== undefined
  );
}

/** Tags shown next to a type: constraints, recursive, deprecated… (nullability is part of the type text). */
function Chips({ node, recursive, hideDeprecated }: { node: SchemaNode; recursive?: boolean; hideDeprecated?: boolean }) {
  return (
    <>
      {constraints(node).map((c) => (
        <span class="chip" key={c}>{c}</span>
      ))}
      {recursive && <span class="chip">recursive</span>}
      {!hideDeprecated && node.schema.deprecated && <span class="chip warn">deprecated</span>}
      {node.missingRef && <span class="chip warn">unresolved {node.missingRef}</span>}
    </>
  );
}

function MetaRow({ label, value }: { label: string; value: unknown }) {
  return (
    <>
      <span class="meta-label">{label}</span>
      <span class="meta-values">
        {/* Objects and arrays too long for one line are laid out over several, indented. */}
        {value && typeof value === "object" ? (
          <pre class="value value-block">{formatJson(value, 60)}</pre>
        ) : (
          <code class="value">{show(value)}</code>
        )}
      </span>
    </>
  );
}

/** Description, allowed values, const, default and example of a node. */
function Details({ node, description, hideDefault }: { node: SchemaNode; description?: string; hideDefault?: boolean }) {
  const direction = useContext(DirectionContext);
  if (!hasDetails(node, direction, description)) return null;
  const s = node.schema;
  const desc = description ?? s.description;
  const example = exampleOf(s);
  return (
    <>
      {desc && <div class="row-desc"><Text>{desc}</Text></div>}
      {/* Label | value(s) in two columns, so every value starts at the same position. */}
      {(s.enum || s.const !== undefined || (showsDefault(s, direction) && !hideDefault) || example !== undefined) && (
        <div class="meta-grid">
          {s.enum && (
            <>
              <span class="meta-label">one of</span>
              <span class="meta-values">
                {s.enum.map((v: unknown) => (
                  <code class="value" key={show(v)}>{show(v)}</code>
                ))}
              </span>
            </>
          )}
          {s.const !== undefined && <MetaRow label="const" value={s.const} />}
          {showsDefault(s, direction) && !hideDefault && <MetaRow label="default" value={s.default} />}
          {example !== undefined && <MetaRow label="example" value={example} />}
        </div>
      )}
    </>
  );
}

/** Nested content of a node: alternatives as tabs, an array's items in [ ], or an object's rows in { }. */
function Content({ doc, node, ancestors, exclude, envelope }: {
  doc: unknown;
  node: SchemaNode;
  ancestors: string[];
  exclude?: ReadonlySet<string>;
  /** Look for a message envelope among the rows (see markEnvelope). */
  envelope?: boolean;
}) {
  const direction = useContext(DirectionContext);
  const inner = node.ref ? [...ancestors, node.ref] : ancestors;
  if (node.variants) return <Variants doc={doc} node={node} ancestors={inner} />;
  const items = itemsOf(doc, node);
  if (items) return <ArrayItems doc={doc} item={items} ancestors={inner} />;
  if (isUnknownObject(node)) return <AnyObject />;
  const all = exclude ? bodyRows(doc, node, direction, exclude) : childrenOf(doc, node, direction);
  const rows = envelope ? markEnvelope(all) : all;
  if (rows.length === 0) return null;
  // Framed by braces so it reads as `{ properties }`, like arrays read as `[ item ]`.
  return (
    <div class="object-block">
      <div class="bracket">{"{"}</div>
      <div class="object-props">
        <SchemaRows doc={doc} rows={rows} ancestors={inner} />
      </div>
      <div class="bracket">{"}"}</div>
    </div>
  );
}

/** Property names that hold the actual content of a message wrapped in an envelope. */
const ENVELOPE_CONTENT = ["payload", "body"];

/**
 * A message payload with a `payload` or `body` property is an envelope around that content: the
 * content starts expanded, and the other properties (metadata) are marked to be shown dimmed.
 */
function markEnvelope(rows: ChildRow[]): ChildRow[] {
  const content = ENVELOPE_CONTENT.map((name) => rows.find((r) => !r.synthetic && r.label === name)).find((r) => r !== undefined);
  if (!content) return rows;
  return rows.map((r) => (r === content ? { ...r, defaultOpen: true } : { ...r, envelope: true }));
}

/** oneOf / anyOf alternatives as horizontal tabs; the selected one is shown below. */
function Variants({ doc, node, ancestors }: { doc: unknown; node: SchemaNode; ancestors: string[] }) {
  const direction = useContext(DirectionContext);
  const options = node.variants!.nodes;
  // With a discriminator, each tab is named after its value: `type: "photo"`.
  const disc = discriminatorValues(doc, node);
  const labels = disc
    ? disc.values.map((v, i) => (
        <>
          {disc.property}: <code class="value">{v}</code>
          {/* The alternative that applies when the property is missing or unmapped (`defaultMapping`). */}
          {i === disc.defaultIndex && <span class="chip tab-chip">default</span>}
        </>
      ))
    : options.map(variantLabel);
  return (
    <Tabs
      labels={labels}
      render={(i) => {
        // In the `defaultMapping` alternative, the discriminator property may be left out.
        const current = disc && i === disc.defaultIndex ? withDiscriminatorDefault(doc, options[i], disc.property, disc.values[i]) : options[i];
        const recursive = current.ref !== undefined && ancestors.includes(current.ref);
        return (
          <>
            <div class="item-head">
              <span class="type">{typeSummary(doc, current)}</span>
              <Chips node={current} recursive={recursive} />
            </div>
            {hasDetails(current, direction) && <div class="row-body"><Details node={current} /></div>}
            {!recursive && <Content doc={doc} node={current} ancestors={ancestors} />}
          </>
        );
      }}
    />
  );
}

/** An object nothing is known about, framed by braces so it reads as `{ any }`, like an untyped array's `[ any ]`. */
function AnyObject() {
  return (
    <div class="object-block">
      <div class="bracket">{"{"}</div>
      <div class="array-item">
        <div class="item-head">
          <span class="type">any</span>
        </div>
      </div>
      <div class="bracket">{"}"}</div>
    </div>
  );
}

/** An array's item schema, framed by brackets so it reads as `[ item ]`. */
function ArrayItems({ doc, item, ancestors }: { doc: unknown; item: SchemaNode; ancestors: string[] }) {
  const direction = useContext(DirectionContext);
  const recursive = item.ref !== undefined && ancestors.includes(item.ref);
  return (
    <div class="array-block">
      <div class="bracket">[</div>
      <div class="array-item">
        <div class="item-head">
          <span class="type">{typeSummary(doc, item)}</span>
          <Chips node={item} recursive={recursive} />
        </div>
        {hasDetails(item, direction) && <div class="row-body"><Details node={item} /></div>}
        {!recursive && <Content doc={doc} node={item} ancestors={ancestors} />}
      </div>
      <div class="bracket">]</div>
    </div>
  );
}

interface RowProps {
  doc: unknown;
  label: string;
  node: SchemaNode;
  required?: boolean;
  synthetic?: boolean;
  description?: string;
  deprecated?: boolean;
  /** $refs of the ancestors, to stop at recursive schemas. */
  ancestors: string[];
  defaultOpen?: boolean;
  envelope?: boolean;
}

/** One property / parameter. Clicking it reveals its details and nested content. */
export function SchemaRow({ doc, label, node, required, synthetic, description, deprecated, ancestors, defaultOpen, envelope }: RowProps) {
  const [open, setOpen] = useState(!!defaultOpen);
  const recursive = node.ref !== undefined && ancestors.includes(node.ref);
  const direction = useContext(DirectionContext);
  // required / optional tags describe what a client must send; they are noise on responses. Except for a
  // discriminator property that `defaultMapping` lets any payload leave out.
  const fromDefaultMapping = node.schema[DEFAULT_MAPPING_MARK] === true;
  const showPresence = !synthetic && (direction === "request" || fromDefaultMapping);
  const nested = !recursive && hasNested(doc, node, direction);
  const isDeprecated = deprecated || node.schema.deprecated;
  // A single possible value. `const|null` has two, so it reads like any other property.
  const isConst = node.schema.const !== undefined && !node.nullable;
  // An optional constant with a default equal to the constant can really be omitted: `optional` and the
  // default stay. Any other case (no default, or a different one) makes both misleading, so both go.
  const optionalConst = isConst && !required && !synthetic;
  const defaultIsConst = optionalConst && show(node.schema.default) === show(node.schema.const);
  const hideOptional = optionalConst && !defaultIsConst;
  const hideDefault = hideOptional;
  // An optional property may be absent, hence `|undefined`. Only in requests, like `optional`:
  // responses rarely say which properties are always present, so it would be mostly noise.
  const type = `${typeSummary(doc, node)}${showPresence && !required && !hideOptional ? "|undefined" : ""}`;

  return (
    <li class={`schema-row${isDeprecated ? " deprecated" : ""}${envelope ? " envelope" : ""}`}>
      {/* Only the name (and `optional` / `deprecated`) is shown; type, tags and details appear when the row is opened. */}
      <div class="row-head expandable" onClick={() => setOpen(!open)} role="button" aria-expanded={open}>
        <span class={synthetic ? "prop synthetic" : "prop"}>{label}{isConst && ":"}</span>
        {/* A constant has a single possible value, so it is shown right away: `type: "photo"`. */}
        {isConst && <code class="value const-value">{show(node.schema.const)}</code>}
        {/* `deprecated` already says "don't rely on it", so `optional` would only add noise. */}
        {showPresence && !required && !isDeprecated && !hideOptional && <span class="chip">optional</span>}
        {isDeprecated && <span class="chip warn">deprecated</span>}
      </div>
      {open && (
        <div class="row-body">
          <div class="row-type">
            <span class="type">{type}</span>
            {showPresence && required && <span class="chip chip-required">required</span>}
            <Chips node={node} recursive={recursive} hideDeprecated />
          </div>
          <Details node={node} description={description} hideDefault={hideDefault} />
        </div>
      )}
      {open && nested && (
        <div class="row-nested">
          <Content doc={doc} node={node} ancestors={ancestors} />
        </div>
      )}
    </li>
  );
}

export function SchemaRows({ doc, rows, ancestors }: { doc: unknown; rows: ReturnType<typeof childrenOf>; ancestors: string[] }) {
  return (
    <ul class="schema">
      {rows.map((r) => (
        <SchemaRow key={r.label} doc={doc} label={r.label} node={r.node} required={r.required} synthetic={r.synthetic} description={r.description} ancestors={ancestors} defaultOpen={r.defaultOpen} envelope={r.envelope} />
      ))}
    </ul>
  );
}

/** A whole schema (request body): its top-level content, already expanded. */
/** `exclude`: top-level properties not to show, e.g. those already listed as path or query parameters. */
/** `envelope`: a message payload, whose `payload` / `body` property marks an envelope (see markEnvelope). */
export function SchemaView({ doc, schema, exclude = new Set(), envelope }: {
  doc: unknown;
  schema: unknown;
  exclude?: ReadonlySet<string>;
  envelope?: boolean;
}) {
  const direction = useContext(DirectionContext);
  const node = toNode(doc, schema);
  const isObject = node.types.includes("object") && !itemsOf(doc, node);
  return (
    <div class="schema-view">
      {/* The body's own type, styled like the type line of any property. */}
      <div class="schema-summary">
        <span class="type">{typeSummary(doc, node)}</span>
        <Chips node={node} />
      </div>
      {node.schema.description && <div class="row-desc"><Text>{node.schema.description}</Text></div>}
      {isObject && !isUnknownObject(node) && bodyRows(doc, node, direction, exclude).length === 0 && <p class="empty">Empty object (no properties).</p>}
      <Content doc={doc} node={node} ancestors={[]} exclude={exclude} envelope={envelope} />
    </div>
  );
}
