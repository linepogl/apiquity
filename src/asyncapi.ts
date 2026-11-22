// AsyncAPI document helpers (3.x, with a fallback for 2.x).
import { deref, withoutHashSuffix } from "./schema.ts";

export interface AsyncApiDoc {
  asyncapi: string;
  info: { title: string; version: string; description?: string };
  channels?: Record<string, any>;
  operations?: Record<string, any>;
  components?: Record<string, any>;
}

export interface AsyncMessage {
  /** Key of the message in its channel (or its component name). */
  key: string;
  /** Display name: the message's `title`, `name` or key. */
  label: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  contentType: string;
  payload?: unknown;
  headers?: unknown;
  /** First example given in the spec, if any. */
  example?: { payload?: unknown; headers?: unknown };
}

export interface AsyncOperation {
  /** Key of the operation (3.x) or of the channel plus the operation kind (2.x). */
  id: string;
  /** "send" / "receive" (3.x); 2.x publish -> receive and subscribe -> send, from the application's side. */
  action: "send" | "receive";
  /** Channel address, falling back to the channel's key. */
  address: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  messages: AsyncMessage[];
}

/** `#asyncapi/<operation id>`: the anchor of an operation in the AsyncAPI tab. */
export const operationAnchor = (op: AsyncOperation) => `asyncapi/${op.id}`;

const lastSegment = (ref: string | undefined) => ref?.split("/").pop()?.replace(/~1/g, "/").replace(/~0/g, "~");

/** A message object (possibly $ref'd) as shown in the panel. */
function toMessage(doc: AsyncApiDoc, raw: unknown, fallbackKey: string): AsyncMessage {
  const { value: m, ref } = deref<any>(doc, raw);
  const key = lastSegment(ref) ?? fallbackKey;
  // A multi-format payload ({ schemaFormat, schema }) wraps the actual schema.
  const payload = m?.payload && typeof m.payload === "object" && "schemaFormat" in m.payload ? m.payload.schema : m?.payload;
  const headers = m?.headers && typeof m.headers === "object" && "schemaFormat" in m.headers ? m.headers.schema : m?.headers;
  const example = Array.isArray(m?.examples) ? m.examples[0] : undefined;
  return {
    key,
    label: m?.title ?? m?.name ?? withoutHashSuffix(key),
    summary: m?.summary,
    description: m?.description,
    deprecated: m?.deprecated,
    contentType: m?.contentType ?? (doc as any).defaultContentType ?? "application/json",
    payload,
    headers,
    example,
  };
}

/** Operations, sorted by channel address, then action. */
export function listOperations(doc: AsyncApiDoc): AsyncOperation[] {
  const out: AsyncOperation[] = [];
  if (doc.operations) {
    for (const [id, raw] of Object.entries(doc.operations)) {
      const op = deref<any>(doc, raw).value;
      const { value: channel, ref } = deref<any>(doc, op.channel);
      const key = lastSegment(ref) ?? id;
      // The operation may restrict the channel's messages; otherwise all of them apply.
      const messages: AsyncMessage[] = Array.isArray(op.messages)
        ? op.messages.map((m: unknown, i: number) => toMessage(doc, m, `message ${i + 1}`))
        : Object.entries<unknown>(channel?.messages ?? {}).map(([k, m]) => toMessage(doc, m, k));
      out.push({
        id,
        action: op.action === "receive" ? "receive" : "send",
        address: channel?.address ?? key,
        summary: op.summary,
        description: op.description,
        deprecated: op.deprecated,
        messages,
      });
    }
  } else {
    // AsyncAPI 2.x: operations live on the channels. `publish` means the application receives the message.
    for (const [address, raw] of Object.entries(doc.channels ?? {})) {
      const channel = deref<any>(doc, raw).value;
      for (const [kind, action] of [["subscribe", "send"], ["publish", "receive"]] as const) {
        const op = channel[kind];
        if (!op) continue;
        const msg = deref<any>(doc, op.message).value;
        const list: unknown[] = msg?.oneOf ?? (op.message ? [op.message] : []);
        out.push({
          id: `${address}#${kind}`,
          action,
          address,
          summary: op.summary,
          description: op.description,
          messages: list.map((m, i) => toMessage(doc, m, list.length > 1 ? `message ${i + 1}` : "message")),
        });
      }
    }
  }
  return out.sort((a, b) => a.address.localeCompare(b.address) || a.action.localeCompare(b.action));
}

/** Namespace of a channel address: everything before the last dot ("a.b.c" -> "a.b"), or "" when there is none. */
export function namespaceOf(address: string): string {
  const i = address.lastIndexOf(".");
  return i > 0 ? address.slice(0, i) : "";
}

/** Name within the namespace: the last dot-separated segment ("a.b.c" -> "c"). */
export function localName(address: string): string {
  return address.slice(address.lastIndexOf(".") + 1);
}

/** Operations grouped by the namespace of their channel, namespaces sorted alphabetically. */
export function groupByNamespace(doc: AsyncApiDoc): { namespace: string; operations: AsyncOperation[] }[] {
  const groups = new Map<string, AsyncOperation[]>();
  for (const op of listOperations(doc)) {
    const ns = namespaceOf(op.address);
    groups.set(ns, [...(groups.get(ns) ?? []), op]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, operations]) => ({ namespace, operations }));
}

/**
 * Channel addresses follow `<company>.<product>.<message_type>.<module>.<message_name>`.
 * The message type, as a badge label: "domain_event" -> EVENT, "command" -> COMMAND, anything else in
 * capitals. Undefined when the address doesn't follow that structure.
 */
export function messageType(address: string): { label: string; kind: string } | undefined {
  const parts = address.split(".");
  if (parts.length !== 5) return undefined;
  const type = parts[2];
  const label = MESSAGE_TYPES[type] ?? type.toUpperCase();
  return { label, kind: label.toLowerCase().replace(/[^a-z0-9]+/g, "-") };
}

const MESSAGE_TYPES: Record<string, string> = { domain_event: "EVENT", command: "COMMAND" };
