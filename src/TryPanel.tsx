// The "Try" tab of an endpoint: fill in its parameters and body, send the request to one of the spec's
// servers, and see the response.
import { useMemo, useState } from "preact/hooks";
import { mediaExample } from "./example.ts";
import { formatJson } from "./json.ts";
import { effectiveParameters, parameterSchema, requestBody, type Endpoint, type OpenApiDoc, type Parameter } from "./openapi.ts";
import { deref, isEmptyBody, toNode } from "./schema.ts";

interface Server {
  url: string;
  description?: string;
}

interface RawServer {
  url?: string;
  description?: string;
  variables?: Record<string, { default?: string }>;
}

/**
 * Where the endpoint can be called: the operation's servers, else its path's, else the document's. Server
 * variables take their default; relative URLs are relative to the spec file. Without any, the spec's own site.
 */
function serversOf(doc: OpenApiDoc, ep: Endpoint, specUrl: string): Server[] {
  const item = doc.paths?.[ep.path] as { servers?: RawServer[] } | undefined;
  const raw: RawServer[] = (ep.op as { servers?: RawServer[] }).servers ?? item?.servers ?? (doc as { servers?: RawServer[] }).servers ?? [];
  const base = new URL(specUrl, location.href);
  const list = raw
    .filter((s) => typeof s.url === "string")
    .map((s) => ({
      url: new URL(s.url!.replace(/\{([^}]+)\}/g, (_, v: string) => s.variables?.[v]?.default ?? ""), base).href,
      description: s.description,
    }));
  return list.length > 0 ? list : [{ url: new URL("/", base).href, description: "The site of the spec" }];
}

/** A parameter's starting value: its example, if the spec gives one (a default needn't be sent, so it is only a hint). */
function initialValue(doc: unknown, p: Parameter): string {
  const schema = deref<any>(doc, parameterSchema(p)).value ?? {};
  const example = (p as { example?: unknown }).example ?? schema.example ?? (Array.isArray(schema.examples) ? schema.examples[0] : undefined);
  return example === undefined ? "" : asText(example);
}

/** A parameter's hint: its default, else its type. */
function placeholderOf(doc: unknown, p: Parameter): string {
  const schema = deref<any>(doc, parameterSchema(p)).value ?? {};
  if (schema.default !== undefined) return asText(schema.default);
  if (Array.isArray(schema.enum)) return schema.enum.map(asText).join(" | ");
  return [].concat(schema.type ?? []).join(" | ");
}

/** A value as typed in a box: strings as they are, arrays comma-separated, anything else as JSON. */
const asText = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.map(asText).join(",") : JSON.stringify(v));

const isArrayParam = (doc: unknown, p: Parameter) => {
  const t = deref<any>(doc, parameterSchema(p)).value?.type;
  return t === "array" || (Array.isArray(t) && t.includes("array"));
};

// The server picked is remembered per spec, across endpoints and visits. Storage may be unavailable
// (private mode…): then the first server is used.
const serverKey = (specUrl: string) => `apiquity-server:${new URL(specUrl, location.href).href}`;
function loadServer(specUrl: string): string | null {
  try {
    return localStorage.getItem(serverKey(specUrl));
  } catch {
    return null;
  }
}
function saveServer(specUrl: string, url: string) {
  try {
    localStorage.setItem(serverKey(specUrl), url);
  } catch {
    // Not remembered.
  }
}

/** A server's name: its description, else its URL without the scheme. */
const serverName = (s: Server) => s.description || s.url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");

const isJson = (mediaType: string) => /[/+]json\b/i.test(mediaType);

interface Result {
  status: number;
  statusText: string;
  ms: number;
  contentType: string;
  body: string;
}

export function TryPanel({ doc, ep, specUrl }: { doc: OpenApiDoc; ep: Endpoint; specUrl: string }) {
  const servers = useMemo(() => serversOf(doc, ep, specUrl), [doc, ep, specUrl]);
  const params = useMemo(() => effectiveParameters(doc, ep).filter((p) => p.in === "path" || p.in === "query"), [doc, ep]);
  const body = useMemo(() => requestBody(doc, ep), [doc, ep]);
  // A GET whose body has nothing to send (no properties besides the path and query parameters) gets no body box.
  const mediaTypes = useMemo(() => {
    const types = Object.keys(body?.content ?? {});
    if (ep.method !== "get") return types;
    const exclude = new Set(params.map((p) => p.name));
    const empty = types.every((t) => {
      const schema = body!.content![t].schema;
      return schema === undefined || isEmptyBody(doc, toNode(doc, schema), "request", exclude);
    });
    return empty ? [] : types;
  }, [doc, ep, body, params]);

  // The server last picked, on any endpoint of this spec, if this endpoint has it; else its first one.
  const [server, setServer] = useState(() => {
    const saved = loadServer(specUrl);
    return servers.find((s) => s.url === saved)?.url ?? servers[0].url;
  });
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(params.map((p) => [`${p.in}:${p.name}`, initialValue(doc, p)])),
  );
  const canSendBody = ep.method !== "get" && ep.method !== "head";
  const [mediaType, setMediaType] = useState(mediaTypes.find(isJson) ?? mediaTypes[0] ?? "");
  // The body starts as the same example as the Example view (path and query parameters left out).
  const exampleBody = (type: string) => {
    const media = body?.content?.[type];
    if (!media || !isJson(type)) return "";
    const exclude = new Set(params.map((p) => p.name));
    return formatJson(mediaExample(doc, media, "request", exclude));
  };
  const [bodyText, setBodyText] = useState(() => exampleBody(mediaType));
  const [result, setResult] = useState<Result | { error: string } | undefined>();
  const [sending, setSending] = useState(false);

  const value = (p: Parameter) => values[`${p.in}:${p.name}`] ?? "";
  const missing = params.filter((p) => (p.in === "path" || p.required) && value(p).trim() === "").map((p) => p.name);

  // The full URL: the server, the path with its parameters filled in, then the query.
  const url = useMemo(() => {
    const path = ep.path.replace(/\{([^}]+)\}/g, (whole, name: string) => {
      const p = params.find((q) => q.in === "path" && q.name === name);
      const v = p ? value(p) : "";
      return v === "" ? whole : encodeURIComponent(v);
    });
    const query = new URLSearchParams();
    for (const p of params.filter((q) => q.in === "query")) {
      const v = value(p);
      if (v === "") continue;
      // Arrays: one `name=value` per item (the default "form, exploded" style).
      for (const item of isArrayParam(doc, p) ? v.split(",").map((s) => s.trim()) : [v]) query.append(p.name, item);
    }
    const q = query.toString();
    return `${server.replace(/\/+$/, "")}${path}${q ? `?${q}` : ""}`;
  }, [server, values, ep, params]);

  const send = async () => {
    setSending(true);
    setResult(undefined);
    const hasBody = canSendBody && mediaType !== "" && bodyText.trim() !== "";
    const headers: Record<string, string> = hasBody ? { "Content-Type": mediaType } : {};
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: ep.method.toUpperCase(),
        headers,
        body: hasBody ? bodyText : undefined,
      });
      const text = await res.text();
      const contentType = res.headers.get("content-type") ?? "";
      let shown = text;
      if (isJson(contentType) || /^\s*[{[]/.test(text)) {
        try {
          shown = formatJson(JSON.parse(text));
        } catch {
          // Not JSON after all: shown as is.
        }
      }
      setResult({ status: res.status, statusText: res.statusText, ms: Math.round(performance.now() - start), contentType, body: shown });
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="try">
      {(["path", "query"] as const).map((loc) => {
        const list = params.filter((p) => p.in === loc);
        if (list.length === 0) return null;
        return (
          <section key={loc} class="panel-section">
            <h4>{loc === "path" ? "Path parameters" : "Query parameters"}</h4>
            <div class="try-fields">
              {list.map((p) => (
                <label key={p.name} class="try-field">
                  <span class="try-label">
                    <code>{p.name}</code>
                    {(loc === "path" || p.required) && <span class="chip chip-required">required</span>}
                  </span>
                  <input
                    class="try-input"
                    value={value(p)}
                    placeholder={placeholderOf(doc, p)}
                    onInput={(e) => {
                      const v = (e.target as HTMLInputElement).value;
                      setValues((old) => ({ ...old, [`${p.in}:${p.name}`]: v }));
                    }}
                  />
                </label>
              ))}
            </div>
          </section>
        );
      })}

      {/* Browsers refuse to send a body with GET or HEAD: say so rather than offer one that would fail. */}
      {mediaTypes.length > 0 && !canSendBody && (
        <section class="panel-section">
          <h4>Body</h4>
          <p class="try-note">
            The spec describes a body, but browsers can't send one with a {ep.method.toUpperCase()} request: it is left out.
          </p>
        </section>
      )}
      {mediaTypes.length > 0 && canSendBody && (
        <section class="panel-section">
          <h4>
            Body
            {mediaTypes.length === 1 ? (
              <span class="badge media-type">{mediaType}</span>
            ) : (
              <select
                class="try-input try-media"
                value={mediaType}
                onChange={(e) => {
                  const type = (e.target as HTMLSelectElement).value;
                  setMediaType(type);
                  setBodyText(exampleBody(type));
                }}
              >
                {mediaTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            )}
            {!body?.required && <span class="chip">optional</span>}
          </h4>
          <textarea
            class="try-input try-body"
            spellcheck={false}
            value={bodyText}
            rows={Math.min(20, Math.max(4, bodyText.split("\n").length + 1))}
            onInput={(e) => setBodyText((e.target as HTMLTextAreaElement).value)}
          />
        </section>
      )}

      <section class="panel-section try-send">
        <code class="try-url">
          <span class={`method m-${ep.method}`}>{ep.method.toUpperCase()}</span>
          {url}
        </code>
        <select
          class="try-input try-server"
          value={server}
          title={server}
          onChange={(e) => {
            const url = (e.target as HTMLSelectElement).value;
            setServer(url);
            saveServer(specUrl, url);
          }}
        >
          {servers.map((s) => (
            <option key={s.url} value={s.url}>{serverName(s)}</option>
          ))}
        </select>
        <button type="button" class="try-button" disabled={sending || missing.length > 0} onClick={send}>
          {sending ? "Sending…" : "Send"}
        </button>
        {missing.length > 0 && <span class="try-missing">Missing: {missing.join(", ")}</span>}
      </section>

      {result && (
        <section class="panel-section">
          <h4>Response</h4>
          {"error" in result ? (
            <p class="try-error">
              The request failed: {result.error.replace(/\.+$/, "")}. The server may be down, or it may not allow requests from this page
              (CORS).
            </p>
          ) : (
            <>
              <div class="try-status">
                <span class={`try-code s${String(result.status)[0]}`}>
                  {result.status} {result.statusText}
                </span>
                <span class="try-meta">{result.ms} ms</span>
                {result.contentType && <span class="badge media-type">{result.contentType}</span>}
              </div>
              {result.body !== "" ? <pre class="raw-schema"><code>{result.body}</code></pre> : <p class="empty">Empty body.</p>}
            </>
          )}
        </section>
      )}
    </div>
  );
}
