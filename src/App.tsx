import { createContext } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  effectiveParameters,
  endpointAnchor,
  groupByTag,
  listEndpoints,
  parameterSchema,
  requestBody,
  responseHeaders,
  responses,
  type Endpoint,
  type OpenApiDoc,
  type Parameter,
  type Response as ApiResponse,
} from "./openapi.ts";
import { childrenOf, inlineRefs, isEmptyBody, toNode } from "./schema.ts";
import { DirectionContext, SchemaRow, SchemaRows, SchemaView, Tabs } from "./SchemaView.tsx";
import { Text } from "./Text.tsx";
import { TryPanel } from "./TryPanel.tsx";
import { mediaExample } from "./example.ts";
import { formatJson } from "./json.ts";
import {
  groupByTag as groupOperationsByTag,
  listOperations,
  localName,
  operationAnchor,
  type AsyncApiDoc,
  type AsyncMessage,
  type AsyncOperation,
} from "./asyncapi.ts";
import { load as loadYaml } from "js-yaml";

/** A loaded spec. */
interface Loaded<T> {
  doc: T;
}

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; openapi?: Loaded<OpenApiDoc>; asyncapi?: Loaded<AsyncApiDoc> };

type SpecKind = "openapi" | "asyncapi";

/**
 * Where the selection (endpoint, tab…) lives: "hash" keeps it in the page's `location.hash`, so links
 * and back/forward work; "none" keeps it inside the component, for pages that use the hash themselves.
 */
export type Routing = "hash" | "none";

export interface AppProps {
  /** URL of the OpenAPI document, JSON or YAML. */
  openapi?: string;
  /** URL of the AsyncAPI document, JSON or YAML. */
  asyncapi?: string;
  routing: Routing;
  /** The title shown in the title bar, instead of the documents' own. */
  title?: string;
  /** The root the app is rendered in (a shadow root), to look up its own elements. */
  root: ParentNode;
  /** Called once the documents are loaded, with the title shown. */
  onLoad?: (title: string) => void;
}


/** Fetches and parses a spec: JSON when it parses as such, YAML otherwise. */
async function loadSpec<T>(url: string, key: SpecKind): Promise<Loaded<T>> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  const text = await r.text();
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = loadYaml(text) as Record<string, unknown>;
  }
  if (!doc || typeof doc !== "object" || !doc[key]) throw new Error(`${url}: not an ${key === "openapi" ? "OpenAPI" : "AsyncAPI"} document`);
  return { doc: doc as T };
}

/** The app's root node, to find its own elements (they're in a shadow root, out of `document`'s reach). */
const RootContext = createContext<ParentNode>(document);

/** Moves to a route (`<anchor>[@<tab>]`); `replace` keeps the move out of the back/forward history. */
type Navigate = (route: string, replace?: boolean) => void;
const NavigateContext = createContext<Navigate>(() => {});

function readHash(): string {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return location.hash.slice(1);
  }
}

/**
 * The hash is `<anchor>[@<tab>]`, e.g. `#post/api/vehicles/search@response-200` for an endpoint, or
 * `#asyncapi/<operation>@message-<key>` for an AsyncAPI operation. The first tab is the default and has no suffix. `@` is rare in URL paths, and a suffix that
 * isn't a known tab id is treated as part of the anchor.
 */
const TAB_SEPARATOR = "@";
const REQUEST_TAB = "request";
const TRY_TAB = "try";
const MESSAGE_TAB_PREFIX = "message-";

/**
 * A search is `#?<query>`: everything after the `?`, as typed. It covers both specs, so it belongs to
 * neither. Endpoint paths never contain a `?`, so it can't be confused with an anchor.
 */
const SEARCH_SEPARATOR = "?";

function parseHash(hash: string): { anchor: string; tab?: string; query: string } {
  const q = hash.indexOf(SEARCH_SEPARATOR);
  if (q >= 0) return { anchor: hash.slice(0, q), query: hash.slice(q + 1) };
  const at = hash.lastIndexOf(TAB_SEPARATOR);
  if (at > 0) {
    const tab = hash.slice(at + 1);
    if (tab === REQUEST_TAB || tab === TRY_TAB || tab === "response" || tab.startsWith("response-") || tab.startsWith(MESSAGE_TAB_PREFIX)) return { anchor: hash.slice(0, at), tab, query: "" };
  }
  return { anchor: hash, query: "" };
}

/**
 * The current route and a way to change it. With hash routing, it is the address bar's `#…` (kept in
 * sync on back/forward); otherwise it is component state.
 */
function useRoute(routing: Routing): [string, Navigate] {
  const [route, setRoute] = useState(() => (routing === "hash" ? readHash() : ""));
  useEffect(() => {
    if (routing !== "hash") return;
    setRoute(readHash());
    const onChange = () => setRoute(readHash());
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, [routing]);
  const navigate = useCallback<Navigate>(
    (to, replace) => {
      if (routing !== "hash") setRoute(to);
      else if (replace) location.replace(`#${to}`); // still fires hashchange
      else location.hash = to;
    },
    [routing],
  );
  return [route, navigate];
}

export function App({ openapi: openapiUrl, asyncapi: asyncapiUrl, routing, title, root, onLoad }: AppProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [hash, navigate] = useRoute(routing);

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    Promise.all([
      openapiUrl ? loadSpec<OpenApiDoc>(openapiUrl, "openapi") : undefined,
      asyncapiUrl ? loadSpec<AsyncApiDoc>(asyncapiUrl, "asyncapi") : undefined,
    ])
      .then(([openapi, asyncapi]) => {
        if (!current) return;
        if (!openapi && !asyncapi) throw new Error('no document: set the "openapi" or "asyncapi" attribute');
        setState({ status: "ready", openapi, asyncapi });
        onLoad?.(title || (openapi ?? asyncapi)!.doc.info.title);
      })
      .catch((e: Error) => current && setState({ status: "error", message: e.message }));
    return () => {
      current = false;
    };
  }, [openapiUrl, asyncapiUrl]);

  // Without hash routing, in-app links (`href="#…"`) change the component's route instead of the page's hash.
  const onClick = (e: MouseEvent) => {
    if (routing === "hash" || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest?.("a[href^='#']");
    if (!a) return;
    e.preventDefault();
    navigate(decodeURIComponent(a.getAttribute("href")!.slice(1)));
  };

  return (
    <RootContext.Provider value={root}>
      <NavigateContext.Provider value={navigate}>
        {/* An empty title: the element's `title` attribute names the API, it isn't a tooltip for all of it. */}
        <div class="host" title="" onClick={onClick}>
          {state.status === "loading" ? (
            <div class="loading" role="status" aria-label="Loading">
              <span class="loading-name">{title || "apiquity"}</span>
              <span class="loading-dot" />
            </div>
          ) : state.status === "error" ? (
            <p class="msg error">Failed to load spec: {state.message}</p>
          ) : (
            <Viewer openapi={state.openapi} asyncapi={state.asyncapi} title={title} hash={hash} routing={routing} urls={{ openapi: openapiUrl, asyncapi: asyncapiUrl }} />
          )}
        </div>
      </NavigateContext.Provider>
    </RootContext.Provider>
  );
}

function Viewer({ openapi, asyncapi, title: titleAttr, hash, routing, urls }: {
  openapi?: Loaded<OpenApiDoc>;
  asyncapi?: Loaded<AsyncApiDoc>;
  title?: string;
  hash: string;
  routing: Routing;
  urls: Partial<Record<SpecKind, string>>;
}) {

  // Endpoints and operations live side by side: an anchor names one or the other (operations' anchors
  // start with `asyncapi/`), whichever spec it comes from.
  const { anchor, tab, query } = parseHash(hash);
  const searching = query.trim() !== "";
  const doc = openapi?.doc;
  const asyncDoc = asyncapi?.doc;
  const selected = doc && anchor ? listEndpoints(doc).find((ep) => endpointAnchor(ep) === anchor) : undefined;
  const selectedOp = asyncDoc && anchor ? listOperations(asyncDoc).find((op) => operationAnchor(op) === anchor) : undefined;
  const split = !!(selected || selectedOp);
  const navigate = useContext(NavigateContext);
  const home = "";
  // The API's title: the `title` attribute, else OpenAPI's when there is one, even if AsyncAPI's differs.
  const title = titleAttr || (openapi ?? asyncapi)!.doc.info.title;
  // The page a search was started from, to return to when it is cleared. Kept after opening a result,
  // so a search reached again with Back still knows where it came from.
  const searchedFrom = useRef<string | null>(null);
  // An older `#asyncapi?<query>` link: the same search, at its one address.
  useEffect(() => {
    if (searching && anchor !== "") navigate(`${SEARCH_SEPARATOR}${query}`, true);
  }, [searching, anchor, query]);
  const search = (q: string) => {
    if (q.trim()) {
      if (!searching) searchedFrom.current = hash;
      // Each keystroke replaces the search in the history, so it is a single entry, right after the
      // page it was started from.
      navigate(`${SEARCH_SEPARATOR}${q}`, searching);
    } else if (!searching) {
      // Already left (e.g. a second "empty" for the same Escape): going back again would leave the page.
    } else if (searchedFrom.current === null) {
      // Opened directly (a link, a reload): nowhere known to return to.
      navigate(home, true);
    } else if (routing === "hash") {
      history.back();
    } else {
      navigate(searchedFrom.current);
    }
  };

  return (
    <div class={split ? "app app-split" : "app"}>
      <div class={split ? "layout split" : "layout"}>
        <header>
          {/* The API's title, which leads to the home page. */}
          <a class="app-title" href="#">{title}</a>
          {/* The spec formats loaded, with their versions: each opens its spec's file in a new tab. */}
          {openapi && <SourceTag url={urls.openapi!} label={`OpenAPI ${openapi.doc.openapi}`} />}
          {asyncapi && <SourceTag url={urls.asyncapi!} label={`AsyncAPI ${asyncapi.doc.asyncapi}`} />}
          <SearchBox query={query} onChange={search} placeholder={openapi && asyncapi ? "Search endpoints and operations" : openapi ? "Search endpoints" : "Search operations"} />
        </header>
        {searching ? (
          // Search results take the list's place, centered like the home page's list.
          <nav class="search-results">
            <h2 class="results-title">Search results</h2>
            <ApiList openapi={doc} asyncapi={asyncDoc} query={query} />
          </nav>
        ) : (
          <nav>
            <ApiList openapi={doc} asyncapi={asyncDoc} selected={selected} selectedOp={selectedOp} tab={tab} />
          </nav>
        )}
        {doc && selected && <EndpointPanel key={anchor} doc={doc} ep={selected} tab={tab} specUrl={urls.openapi!} />}
        {asyncDoc && selectedOp && <OperationPanel key={anchor} doc={asyncDoc} op={selectedOp} tab={tab} />}
      </div>
    </div>
  );
}

/**
 * Searches the endpoints / operations: the query goes to the address (`#?<query>`) and the results
 * replace the list, centered. Every word must appear (ignoring case) in one of an item's texts (path, method,
 * summary, tag…). Escape (anywhere), or emptying it, returns to the page the search was started from.
 * Typing anywhere goes to it.
 */
function SearchBox({ query, onChange, placeholder }: { query: string; onChange: (q: string) => void; placeholder: string }) {
  const input = useRef<HTMLInputElement>(null);
  // The latest onChange, for the document's key listener, set up once.
  const change = useRef(onChange);
  change.current = onChange;
  // Escape empties the box and takes the focus out of it, wherever the focus is.
  const escape = () => {
    if (input.current?.value) change.current("");
    input.current?.blur();
  };
  // Typing anywhere goes to the box: a character key moves the focus there (cursor at the end) and the
  // character lands in it. Not space (it scrolls the page), shortcuts, or keys typed in another field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // In the box itself, its own handler has already done it.
      if (e.key === "Escape") {
        if (!e.composedPath().includes(input.current!)) escape();
        return;
      }
      if (e.key.length !== 1 || e.key === " " || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return;
      // composedPath() sees through shadow roots, where e.target would only be the host element.
      const typing = e.composedPath().some(
        (n) => n instanceof HTMLElement && (n.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(n.tagName)),
      );
      if (typing || !input.current) return;
      const end = input.current.value.length;
      input.current.focus();
      input.current.setSelectionRange(end, end);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // A magnifying glass instead of placeholder text; the label stays for screen readers.
  return (
    <span class="search-box">
      <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path d="m10.5 10.5 3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <input
        ref={input}
        class="search"
        type="search"
        value={query}
        title={`${placeholder} (just start typing)`}
        aria-label={placeholder}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // The browser would also clear a search box on Escape, emptying it a second time.
          e.preventDefault();
          escape();
        }}
      />
    </span>
  );
}

/** Whether every word of the query appears in one of the texts, ignoring case. An empty query matches everything. */
function matches(query: string, texts: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = texts.filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** A spec format tag in the title bar ("OpenAPI 3.1.0"): opens the spec's file, as is, in a new tab. */
function SourceTag({ url, label }: { url: string; label: string }) {
  return (
    <a class="badge source-tag" href={url} target="_blank" rel="noopener" title="Open the file in a new tab">
      {label}
    </a>
  );
}

/** The operation's action, as in the AsyncAPI standard: SEND or RECEIVE. */
function OperationBadge({ op }: { op: AsyncOperation }) {
  return <span class={`method m-${op.action}`}>{op.action.toUpperCase()}</span>;
}

/**
 * Keeps the selected row of the list visible, e.g. when opening an endpoint from the home page, a deep
 * link or back/forward. A row out of view is scrolled up to the top of the list, together with its
 * group's heading when both fit; a row already in view (just clicked) stays where it is.
 */
function useScrollSelectedIntoView(selected: unknown) {
  const root = useContext(RootContext);
  useEffect(() => {
    const row = root.querySelector<HTMLElement>("nav li.selected");
    const list = row?.closest("nav");
    if (!row || !list) return;
    const r = row.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    if (r.top >= l.top && r.bottom <= l.bottom) return;
    // The group's heading on top, unless the group is so long that the row would then be out of view.
    const section = row.closest("section")?.getBoundingClientRect();
    const top = section && r.bottom - section.top <= l.height - 8 ? section.top : r.top;
    list.scrollTop += top - l.top - 8;
  }, [selected]);
}

/** An endpoint's tabs: Request, one per response, then Try (call the endpoint). */
const endpointTabIds = (doc: OpenApiDoc, ep: Endpoint) => [
  REQUEST_TAB,
  ...responses(doc, ep).map((r) => (r.status === "default" ? "response" : `response-${r.status}`)),
  TRY_TAB,
];

/** An operation's tabs: one per message. */
const operationTabIds = (op: AsyncOperation) => op.messages.map((m) => MESSAGE_TAB_PREFIX + m.key);

/** A link to a page, on the tab that is open now if that page has it too (the first tab needs no suffix). */
const linkTo = (anchor: string, tabIds: string[], tab?: string) =>
  `#${anchor}${tab && tab !== tabIds[0] && tabIds.includes(tab) ? TAB_SEPARATOR + tab : ""}`;

/** An endpoint's row in a list: method and path (the summary shows on the endpoint's page). */
function EndpointRow({ doc, ep, selected, tab }: { doc: OpenApiDoc; ep: Endpoint; selected?: Endpoint; tab?: string }) {
  const anchor = endpointAnchor(ep);
  const isSelected = selected !== undefined && anchor === endpointAnchor(selected);
  const cls = [isSelected && "selected", ep.op.deprecated && "deprecated"].filter(Boolean).join(" ");
  return (
    <li class={cls}>
      <a href={linkTo(anchor, endpointTabIds(doc, ep), tab)} aria-current={isSelected ? "true" : undefined}>
        <span class={`method m-${ep.method}`}>{ep.method.toUpperCase()}</span>
        <code class="path">{ep.path}</code>
      </a>
    </li>
  );
}

/** An envelope, marking messages and message-based operations. */
function EnvelopeIcon() {
  return (
    <svg class="op-icon" viewBox="0 0 18 13" width="15" height="11" aria-hidden="true">
      <rect class="op-icon-paper" x="0.75" y="0.75" width="16.5" height="11.5" rx="1.5" stroke="currentColor" stroke-width="1.5" />
      <path d="M1.5 1.5 9 7.5l7.5-6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
  );
}

/** An operation's row in a list: action, the last segment of its address, and summary. */
function OperationRow({ op, selected, tab }: { op: AsyncOperation; selected?: AsyncOperation; tab?: string }) {
  const isSelected = selected?.id === op.id;
  const cls = [isSelected && "selected", op.deprecated && "deprecated"].filter(Boolean).join(" ");
  return (
    <li class={cls}>
      {/* Only the last segment of the address ("offer_created"); the full one is in the tooltip. */}
      <a href={linkTo(operationAnchor(op), operationTabIds(op), tab)} title={op.address} aria-current={isSelected ? "true" : undefined}>
        <OperationBadge op={op} />
        {/* An envelope marks a message-based operation, apart from the endpoints' paths. It stands on its
            own, beside the name, so a long name wraps under itself. */}
        <span class="op-name">
          <EnvelopeIcon />
          <code class="path">{localName(op.address)}</code>
        </span>
        {op.summary && <span class="summary">{op.summary}</span>}
      </a>
    </li>
  );
}

/**
 * Endpoints and operations together, in sections named after their tags: a name found in both specs is
 * one section (its endpoints, then its operations), and sections are sorted alphabetically. Used for the
 * home page, the left column and, with a `query`, the search results.
 */
function ApiList({ openapi, asyncapi, selected, selectedOp, tab, query = "" }: {
  openapi?: OpenApiDoc;
  asyncapi?: AsyncApiDoc;
  selected?: Endpoint;
  selectedOp?: AsyncOperation;
  /** The tab open now: the rows link to the same tab of their page, when it has one. */
  tab?: string;
  query?: string;
}) {
  useScrollSelectedIntoView(selected ?? selectedOp);
  const sections = new Map<string, { description?: string; endpoints: Endpoint[]; operations: AsyncOperation[] }>();
  const section = (tag: string) => {
    if (!sections.has(tag)) sections.set(tag, { endpoints: [], operations: [] });
    return sections.get(tag)!;
  };
  for (const g of openapi ? groupByTag(openapi) : []) {
    for (const ep of g.endpoints) {
      if (!matches(query, [g.tag, ep.method, ep.path, ep.op.summary, ep.op.operationId])) continue;
      const sec = section(g.tag);
      sec.description ??= g.description;
      sec.endpoints.push(ep);
    }
  }
  for (const g of asyncapi ? groupOperationsByTag(asyncapi) : []) {
    for (const op of g.operations) {
      if (matches(query, [g.tag, op.address, op.action, op.summary, op.id, ...op.messages.map((m) => m.label)])) {
        section(g.tag).operations.push(op);
      }
    }
  }
  if (sections.size === 0) return <p class="empty">{query.trim() ? `Nothing matches “${query.trim()}”.` : "No endpoints or operations."}</p>;
  return (
    <>
      {[...sections.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tag, { description, endpoints, operations }]) => (
          <section key={tag}>
            {/* Untagged endpoints and operations: a section without a heading. */}
            {tag && <h2>{tag}</h2>}
            {description && <p class="desc"><Text>{description}</Text></p>}
            <ul class="endpoints">
              {endpoints.map((ep) => (
                <EndpointRow key={endpointAnchor(ep)} doc={openapi!} ep={ep} selected={selected} tab={tab} />
              ))}
              {operations.map((op) => (
                <OperationRow key={op.id} op={op} selected={selectedOp} tab={tab} />
              ))}
            </ul>
          </section>
        ))}
    </>
  );
}

const PARAM_SECTIONS: { in: Parameter["in"]; title: string }[] = [
  { in: "path", title: "Path parameters" },
  { in: "query", title: "Query parameters" },
  { in: "header", title: "Headers" },
  { in: "cookie", title: "Cookies" },
];

interface NamedField {
  name: string;
  schema: unknown;
  required?: boolean;
  description?: string;
  deprecated?: boolean;
}

/** Parameters or headers, as schema rows. */
function FieldList({ doc, title, fields }: { doc: unknown; title: string; fields: NamedField[] }) {
  if (fields.length === 0) return null;
  return (
    <section class="panel-section">
      <h4>{title}</h4>
      <ul class="schema">
        {fields.map((f) => (
          <SchemaRow
            key={f.name}
            doc={doc}
            label={f.name}
            node={toNode(doc, f.schema)}
            required={f.required}
            description={f.description}
            deprecated={f.deprecated}
            ancestors={[]}
          />
        ))}
      </ul>
    </section>
  );
}

type BodyView = "fields" | "example" | "schema";
const BODY_VIEWS: [BodyView, string][] = [
  ["fields", "Fields"],
  ["example", "Example"],
  ["schema", "JSON Schema"],
];

/** A request or response body, or a message payload: media type(s) and schema. */
function BodySection({
  doc,
  content,
  title = "Body",
  description,
  optional,
  exclude,
  envelope,
}: {
  doc: unknown;
  content: Record<string, { schema?: unknown; example?: unknown }>;
  title?: string;
  description?: string;
  optional?: boolean;
  exclude?: ReadonlySet<string>;
  /** A message payload: a `payload` / `body` property marks an envelope. */
  envelope?: boolean;
}) {
  const [view, setView] = useState<BodyView>("fields");
  const entries = Object.entries(content);
  if (entries.length === 0) return null;
  return (
    <section class="panel-section">
      <h4>
        {title}
        {/* A single media type goes in the title; several get one heading each below. */}
        {entries.length === 1 && <span class="badge media-type">{entries[0][0]}</span>}
        {optional && <span class="chip">optional</span>}
        <span class="view-toggle" role="group" aria-label="Body view">
          {BODY_VIEWS.map(([id, label]) => (
            <button key={id} type="button" class={view === id ? "active" : ""} aria-pressed={view === id} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </span>
      </h4>
      {description && <div class="row-desc"><Text>{description}</Text></div>}
      {entries.map(([mediaType, media]) => (
        <div key={mediaType} class="media">
          {entries.length > 1 && <span class="badge media-type">{mediaType}</span>}
          {media.schema === undefined ? (
            <p class="empty">No schema.</p>
          ) : view === "schema" ? (
            <RawSchema doc={doc} schema={media.schema} />
          ) : view === "example" ? (
            <BodyExample doc={doc} media={media} exclude={exclude} />
          ) : (
            <SchemaView doc={doc} schema={media.schema} exclude={exclude} envelope={envelope} />
          )}
        </div>
      ))}
    </section>
  );
}

/** An example body: the spec's own, or one built from the schema. */
function BodyExample({ doc, media, exclude }: { doc: unknown; media: { schema?: unknown; example?: unknown }; exclude?: ReadonlySet<string> }) {
  const direction = useContext(DirectionContext);
  const text = useMemo(() => formatJson(mediaExample(doc, media, direction, exclude)), [doc, media, direction, exclude]);
  return <pre class="raw-schema"><code>{text}</code></pre>;
}

/** The body's JSON Schema as written in the spec, with $refs inlined. */
function RawSchema({ doc, schema }: { doc: unknown; schema: unknown }) {
  const text = useMemo(() => formatJson(inlineRefs(doc, schema)), [doc, schema]);
  return <pre class="raw-schema"><code>{text}</code></pre>;
}

/** CSS class for a status code tab: s2 for 2XX, s4 for 4XX…, s-default otherwise. */
const statusClass = (status: string) => (/^[1-5]/.test(status) ? `status s${status[0]}` : "status s-default");

function RequestPanel({ doc, ep }: { doc: OpenApiDoc; ep: Endpoint }) {
  const params = effectiveParameters(doc, ep);
  const body = requestBody(doc, ep);
  // Body properties that repeat a path or query parameter are hidden, and so is a body left with nothing else.
  const exclude = new Set(params.filter((p) => p.in === "path" || p.in === "query").map((p) => p.name));
  const content = Object.fromEntries(
    Object.entries(body?.content ?? {}).filter(
      ([, m]) => m.schema === undefined || !isEmptyBody(doc, toNode(doc, m.schema), "request", exclude),
    ),
  );
  const hasBody = Object.keys(content).length > 0;
  return (
    <>
      {PARAM_SECTIONS.map(({ in: loc, title }) => (
        <FieldList
          key={loc}
          doc={doc}
          title={title}
          fields={params.filter((p) => p.in === loc).map((p) => ({ ...p, schema: parameterSchema(p) }))}
        />
      ))}
      {body && hasBody && (
        <BodySection doc={doc} content={content} description={body.description} optional={!body.required} exclude={exclude} />
      )}
      {params.length === 0 && !hasBody && <p class="empty">No parameters and no body.</p>}
    </>
  );
}

function ResponsePanel({ doc, response }: { doc: OpenApiDoc; response: ApiResponse }) {
  const headers = responseHeaders(doc, response);
  const hasBody = Object.keys(response.content ?? {}).length > 0;
  return (
    <DirectionContext.Provider value="response">
      {response.description && <div class="row-desc response-desc"><Text>{response.description}</Text></div>}
      <FieldList
        doc={doc}
        title="Headers"
        fields={headers.map(({ name, header }) => ({ name, schema: parameterSchema(header), ...header }))}
      />
      <BodySection doc={doc} content={response.content ?? {}} />
      {!hasBody && <p class="empty">No body.</p>}
    </DirectionContext.Provider>
  );
}

function EndpointPanel({ doc, ep, tab, specUrl }: { doc: OpenApiDoc; ep: Endpoint; tab?: string; specUrl: string }) {
  const list = responses(doc, ep);
  const tabIds = endpointTabIds(doc, ep);
  const tryIndex = tabIds.length - 1;
  // Unknown or missing tab in the URL -> Request.
  const selectedTab = Math.max(0, tabIds.indexOf(tab ?? REQUEST_TAB));
  // Tab switches stay out of the back/forward history.
  const navigate = useContext(NavigateContext);
  const selectTab = (i: number) => navigate(`${endpointAnchor(ep)}${i === 0 ? "" : TAB_SEPARATOR + tabIds[i]}`, true);

  return (
    <article class="panel">
      <h2 class="panel-title">
        <span class={`method m-${ep.method}`}>{ep.method.toUpperCase()}</span>
        <code class="path">{ep.path}</code>
        {ep.op.deprecated && <span class="badge">deprecated</span>}
      </h2>
      {ep.op.summary && <p class="panel-summary">{ep.op.summary}</p>}
      {ep.op.description && <div class="description"><Text>{ep.op.description}</Text></div>}

      {/* Request | Response 200 | Response 404 … | Try */}
      <Tabs
        className="endpoint-tabs"
        selected={selectedTab}
        onSelect={selectTab}
        labels={["Request", ...list.map((r) => (r.status === "default" ? "Response" : `Response ${r.status}`)), "Try"]}
        tabClass={(i) => (i === 0 ? "" : i === tryIndex ? "try-tab" : statusClass(list[i - 1].status))}
        render={(i) =>
          i === 0 ? (
            <RequestPanel doc={doc} ep={ep} />
          ) : i === tryIndex ? (
            <TryPanel doc={doc} ep={ep} specUrl={specUrl} />
          ) : (
            <ResponsePanel doc={doc} response={list[i - 1].response} />
          )
        }
      />
    </article>
  );
}

/**
 * One message of an AsyncAPI operation: headers and payload, shown like a request or response body.
 * Messages the application sends are read by others, so they're shown like responses (no defaults,
 * no optional/required); messages it receives must be built by others, so they're shown like requests.
 */
function MessageContent({ doc, op, message }: { doc: AsyncApiDoc; op: AsyncOperation; message: AsyncMessage }) {
  const direction = op.action === "send" ? "response" : "request";
  const headers = message.headers !== undefined ? childrenOf(doc, toNode(doc, message.headers), direction) : [];
  return (
    <DirectionContext.Provider value={direction}>
      {message.summary && <div class="row-desc response-desc"><Text>{message.summary}</Text></div>}
      {message.description && <div class="row-desc response-desc"><Text>{message.description}</Text></div>}
      {headers.length > 0 && (
        <section class="panel-section">
          <h4>Headers</h4>
          <SchemaRows doc={doc} rows={headers} ancestors={[]} />
        </section>
      )}
      {message.payload !== undefined ? (
        <BodySection
          doc={doc}
          content={{ [message.contentType]: { schema: message.payload, example: message.example?.payload } }}
          envelope
        />
      ) : (
        <p class="empty">No body.</p>
      )}
    </DirectionContext.Provider>
  );
}

/** An AsyncAPI operation, laid out like an endpoint: title, description, then one tab per message. */
function OperationPanel({ doc, op, tab }: { doc: AsyncApiDoc; op: AsyncOperation; tab?: string }) {
  const tabIds = operationTabIds(op);
  // Unknown or missing tab in the URL -> the first message.
  const selectedTab = Math.max(0, tab ? tabIds.indexOf(tab) : 0);
  const navigate = useContext(NavigateContext);
  const selectTab = (i: number) => navigate(`${operationAnchor(op)}${i === 0 ? "" : TAB_SEPARATOR + tabIds[i]}`, true);

  return (
    <article class="panel">
      <h2 class="panel-title">
        <OperationBadge op={op} />
        <code class="path">{op.address}</code>
        {op.deprecated && <span class="badge">deprecated</span>}
      </h2>
      {op.summary && <p class="panel-summary">{op.summary}</p>}
      {op.description && <div class="description"><Text>{op.description}</Text></div>}

      {op.messages.length === 0 ? (
        <p class="empty">No message.</p>
      ) : (
        <Tabs
          className="endpoint-tabs"
          selected={selectedTab}
          onSelect={selectTab}
          labels={op.messages.map((m) => (
            <span class="message-tab">
              <EnvelopeIcon />
              {m.label}
            </span>
          ))}
          render={(i) => <MessageContent doc={doc} op={op} message={op.messages[i]} />}
        />
      )}
    </article>
  );
}

