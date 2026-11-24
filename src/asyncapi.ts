// AsyncAPI document helpers (3.x, with a fallback for 2.x).
import { deref, withoutHashSuffix } from "./schema.ts";

export interface AsyncTag {
  name: string;
  description?: string;
}

export interface AsyncApiDoc {
  asyncapi: string;
  /** 3.x: the document's tags are in `info.tags`. */
  info: { title: string; version: string; description?: string; tags?: unknown[] };
  /** 2.x: the document's tags. */
  tags?: unknown[];
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
  /** The operation's tags, $refs resolved; the first one groups the operation in the list. */
  tags: AsyncTag[];
  messages: AsyncMessage[];
}

/** `#asyncapi/<operation id>`: the anchor of an operation in the AsyncAPI tab. */
export const operationAnchor = (op: AsyncOperation) => `asyncapi/${op.id}`;

const lastSegment = (ref: string | undefined) => ref?.split("/").pop()?.replace(/~1/g, "/").replace(/~0/g, "~");

/** Tag objects (possibly $ref'd to `components.tags`), those without a name left out. */
function toTags(doc: AsyncApiDoc, raw: unknown): AsyncTag[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => deref<any>(doc, t).value)
    .filter((t) => typeof t?.name === "string")
    .map((t) => ({ name: t.name, description: t.description }));
}

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
        tags: toTags(doc, op.tags),
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
          tags: toTags(doc, op.tags),
          messages: list.map((m, i) => toMessage(doc, m, list.length > 1 ? `message ${i + 1}` : "message")),
        });
      }
    }
  }
  return out.sort((a, b) => a.address.localeCompare(b.address) || a.action.localeCompare(b.action));
}

/** Last dot-separated segment of a channel address ("a.b.c" -> "c"). */
export function localName(address: string): string {
  return address.slice(address.lastIndexOf(".") + 1);
}

export interface OperationGroup {
  tag: string;
  operations: AsyncOperation[];
}

/** Group of the operations left without any tag: no name, shown without a heading, first. */
const UNTAGGED = "";

/**
 * Operations grouped by their tags:
 * 1. a tag found on every operation tells them apart from nothing, so it is ignored (when there are at
 *    least two operations);
 * 2. the group is named after the operation's other tags, in their order, joined with a space
 *    ("" when none is left: the untagged group, sorted first).
 * Groups are sorted alphabetically.
 */
export function groupByTag(doc: AsyncApiDoc): OperationGroup[] {
  const operations = listOperations(doc);
  const names = operations.map((op) => [...new Set(op.tags.map((t) => t.name))]);
  const common = new Set(operations.length > 1 ? names.reduce((acc, n) => acc.filter((t) => n.includes(t))) : []);
  const groups = new Map<string, OperationGroup>();
  operations.forEach((op, i) => {
    const tag = names[i].filter((t) => !common.has(t)).join(" ") || UNTAGGED;
    if (!groups.has(tag)) groups.set(tag, { tag, operations: [] });
    groups.get(tag)!.operations.push(op);
  });
  return [...groups.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}
