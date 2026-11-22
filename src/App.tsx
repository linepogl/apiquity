import { createContext } from "preact";
import { useCallback, useContext, useEffect, useMemo, useState } from "preact/hooks";
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
import { mediaExample } from "./example.ts";
import { formatJson } from "./json.ts";
import {
  groupByNamespace,
  listOperations,
  localName,
  messageType,
  operationAnchor,
  type AsyncApiDoc,
  type AsyncMessage,
  type AsyncOperation,
} from "./asyncapi.ts";
import { load as loadYaml } from "js-yaml";

/** A loaded spec and the name of its source file. */
interface Loaded<T> {
  doc: T;
  fileName: string;
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
  /** The root the app is rendered in (a shadow root), to look up its own elements. */
  root: ParentNode;
  /** Called once the documents are loaded, with the title of the first one. */
  onLoad?: (title: string) => void;
}

/** Hash of the AsyncAPI tab (OpenAPI, the default, has none). */
const ASYNCAPI_HASH = "asyncapi";

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
  // The file name, for the raw-file link: the last segment of the URL.
  const fileName = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || url);
  return { doc: doc as T, fileName };
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
const MESSAGE_TAB_PREFIX = "message-";

function parseHash(hash: string): { anchor: string; tab?: string } {
  const at = hash.lastIndexOf(TAB_SEPARATOR);
  if (at > 0) {
    const tab = hash.slice(at + 1);
    if (tab === REQUEST_TAB || tab.startsWith("response-") || tab.startsWith(MESSAGE_TAB_PREFIX)) return { anchor: hash.slice(0, at), tab };
  }
  return { anchor: hash };
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

export function App({ openapi: openapiUrl, asyncapi: asyncapiUrl, routing, root, onLoad }: AppProps) {
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
        onLoad?.((openapi ?? asyncapi)!.doc.info.title);
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
        <div class="host" onClick={onClick}>
          {state.status === "loading" ? (
            <p class="msg">Loading…</p>
          ) : state.status === "error" ? (
            <p class="msg error">Failed to load spec: {state.message}</p>
          ) : (
            <Viewer openapi={state.openapi} asyncapi={state.asyncapi} hash={hash} urls={{ openapi: openapiUrl, asyncapi: asyncapiUrl }} />
          )}
        </div>
      </NavigateContext.Provider>
    </RootContext.Provider>
  );
}

function Viewer({ openapi, asyncapi, hash, urls }: {
  openapi?: Loaded<OpenApiDoc>;
  asyncapi?: Loaded<AsyncApiDoc>;
  hash: string;
  urls: Partial<Record<SpecKind, string>>;
}) {

  // OpenAPI is the default; `#asyncapi…` selects AsyncAPI. With a single spec, that one is shown.
  const view: SpecKind = !openapi || (asyncapi && hash.startsWith(ASYNCAPI_HASH)) ? "asyncapi" : "openapi";
  const doc = view === "openapi" ? openapi?.doc : undefined;
  const { anchor, tab } = parseHash(hash);
  const selected = doc && anchor ? listEndpoints(doc).find((ep) => endpointAnchor(ep) === anchor) : undefined;
  const asyncDoc = view === "asyncapi" ? asyncapi?.doc : undefined;
  const selectedOp = asyncDoc && anchor ? listOperations(asyncDoc).find((op) => operationAnchor(op) === anchor) : undefined;
  const active = (view === "openapi" ? openapi : asyncapi)!;
  const split = !!(selected || selectedOp);

  return (
    <div class={split ? "app app-split" : "app"}>
      {/* One tab per spec, only when there are two: above everything, across the whole window. */}
      {openapi && asyncapi && (
        <div class="tabs spec-tabs" role="tablist">
          <a href="#" role="tab" aria-selected={view === "openapi"} class={`tab${view === "openapi" ? " active" : ""}`}>
            OpenAPI
          </a>
          <a href={`#${ASYNCAPI_HASH}`} role="tab" aria-selected={view === "asyncapi"} class={`tab${view === "asyncapi" ? " active" : ""}`}>
            AsyncAPI
          </a>
        </div>
      )}
      <div class={split ? "layout split" : "layout"}>
        <header>
          <h1>
            <a href={view === "openapi" ? "#" : `#${ASYNCAPI_HASH}`} class="home">{active.doc.info.title}</a>{" "}
            <span class="version">{active.doc.info.version}</span>
          </h1>
          {/* The spec version, as a tag next to the title. */}
          <span class="badge">
            {view === "openapi" ? `OpenAPI ${openapi!.doc.openapi}` : `AsyncAPI ${asyncapi!.doc.asyncapi}`}
          </span>
          <RawLink url={urls[view]!} fileName={active.fileName} />
        </header>
        <nav>
          {doc && <EndpointList doc={doc} selected={selected} />}
          {asyncDoc && <OperationList doc={asyncDoc} selected={selectedOp} />}
        </nav>
        {doc && selected && <EndpointPanel key={anchor} doc={doc} ep={selected} tab={tab} />}
        {asyncDoc && selectedOp && <OperationPanel key={anchor} doc={asyncDoc} op={selectedOp} tab={tab} />}
      </div>
    </div>
  );
}

/** Link to a spec file as is, opened in a new tab. */
function RawLink({ url, fileName }: { url: string; fileName: string }) {
  return (
    <a class="download" href={url} target="_blank" rel="noopener" title="Open the raw file in a new tab">
      {fileName}
    </a>
  );
}

/** The message type from the channel address (EVENT, COMMAND…), or the action when the address has no such part. */
function OperationBadge({ op }: { op: AsyncOperation }) {
  const type = messageType(op.address);
  return type ? (
    <span class={`method mt-${type.kind}`}>{type.label}</span>
  ) : (
    <span class={`method m-${op.action}`}>{op.action.toUpperCase()}</span>
  );
}

/** Keeps the selected row of the list visible, e.g. when opening a deep link or using back/forward. */
function useScrollSelectedIntoView(selected: unknown) {
  const root = useContext(RootContext);
  useEffect(() => {
    root.querySelector("nav li.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);
}

/** AsyncAPI operations, grouped by the namespace of their channel (the address up to its last dot). */
function OperationList({ doc, selected }: { doc: AsyncApiDoc; selected?: AsyncOperation }) {
  useScrollSelectedIntoView(selected);
  const groups = groupByNamespace(doc);
  if (groups.length === 0) return <p class="empty">No operations.</p>;
  return (
    <>
      {groups.map((g) => (
        <section key={g.namespace} class="events">
          {/* Only the last segment of the namespace ("offer"); the full one is in the tooltip. */}
          <h2 class="namespace" title={g.namespace || undefined}>{g.namespace ? localName(g.namespace) : "No namespace"}</h2>
          <ul class="endpoints">
            {g.operations.map((op) => {
              const isSelected = selected?.id === op.id;
              const cls = [isSelected && "selected", op.deprecated && "deprecated"].filter(Boolean).join(" ");
              return (
                <li key={op.id} class={cls}>
                  {/* The namespace is the heading, so each row shows only the rest of the address. */}
                  <a href={`#${operationAnchor(op)}`} title={op.address} aria-current={isSelected ? "true" : undefined}>
                    <OperationBadge op={op} />
                    <code class="path">{localName(op.address)}</code>
                    {op.summary && <span class="summary">{op.summary}</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

function EndpointList({ doc, selected }: { doc: OpenApiDoc; selected?: Endpoint }) {
  useScrollSelectedIntoView(selected);

  return (
    <>
      {groupByTag(doc).map((g) => (
        <section key={g.tag}>
          <h2>{g.tag}</h2>
          {g.description && <p class="desc"><Text>{g.description}</Text></p>}
          <ul class="endpoints">
            {g.endpoints.map((ep) => {
              const anchor = endpointAnchor(ep);
              const isSelected = selected !== undefined && anchor === endpointAnchor(selected);
              const cls = [isSelected && "selected", ep.op.deprecated && "deprecated"].filter(Boolean).join(" ");
              return (
                <li key={anchor} class={cls}>
                  <a href={`#${anchor}`} aria-current={isSelected ? "true" : undefined}>
                    <span class={`method m-${ep.method}`}>{ep.method.toUpperCase()}</span>
                    <code class="path">{ep.path}</code>
                    {ep.op.summary && <span class="summary">{ep.op.summary}</span>}
                  </a>
                </li>
              );
            })}
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
}: {
  doc: unknown;
  content: Record<string, { schema?: unknown; example?: unknown }>;
  title?: string;
  description?: string;
  optional?: boolean;
  exclude?: ReadonlySet<string>;
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
            <SchemaView doc={doc} schema={media.schema} exclude={exclude} />
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

function EndpointPanel({ doc, ep, tab }: { doc: OpenApiDoc; ep: Endpoint; tab?: string }) {
  const list = responses(doc, ep);
  const tabIds = [REQUEST_TAB, ...list.map((r) => `response-${r.status}`)];
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

      {/* Request | Response 200 | Response 404 … */}
      <Tabs
        className="endpoint-tabs"
        selected={selectedTab}
        onSelect={selectTab}
        labels={["Request", ...list.map((r) => `Response ${r.status}`)]}
        tabClass={(i) => (i === 0 ? "" : statusClass(list[i - 1].status))}
        render={(i) => (i === 0 ? <RequestPanel doc={doc} ep={ep} /> : <ResponsePanel doc={doc} response={list[i - 1].response} />)}
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
          title="Payload"
          content={{ [message.contentType]: { schema: message.payload, example: message.example?.payload } }}
        />
      ) : (
        <p class="empty">No payload.</p>
      )}
    </DirectionContext.Provider>
  );
}

/** An AsyncAPI operation, laid out like an endpoint: title, description, then one tab per message. */
function OperationPanel({ doc, op, tab }: { doc: AsyncApiDoc; op: AsyncOperation; tab?: string }) {
  const tabIds = op.messages.map((m) => MESSAGE_TAB_PREFIX + m.key);
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
          labels={op.messages.map((m) => m.label)}
          render={(i) => <MessageContent doc={doc} op={op} message={op.messages[i]} />}
        />
      )}
    </article>
  );
}

