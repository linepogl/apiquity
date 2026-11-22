// Pretty-prints JSON the way a person would: a value that fits on the line stays on one line,
// otherwise its members go on their own lines, indented.

/** One-line JSON with a space after `:` and `,`, e.g. `{ "a": 1, "b": [1, 2] }`. */
function compact(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[${v.map(compact).join(", ")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    return entries.length === 0 ? "{}" : `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${compact(x)}`).join(", ")} }`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Formats `value` with `indent` spaces per level, keeping any object or array on a single line when it
 * fits within `width` columns (counting the indentation and the key before it).
 */
export function formatJson(value: unknown, width = 72, indent = 2): string {
  const format = (v: unknown, depth: number, prefixLength: number): string => {
    const flat = compact(v);
    if (!v || typeof v !== "object" || depth * indent + prefixLength + flat.length <= width) return flat;
    const pad = " ".repeat((depth + 1) * indent);
    const end = " ".repeat(depth * indent);
    if (Array.isArray(v)) {
      return `[\n${v.map((x) => pad + format(x, depth + 1, 1)).join(",\n")}\n${end}]`;
    }
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    const lines = entries.map(([k, x]) => {
      const key = `${JSON.stringify(k)}: `;
      return pad + key + format(x, depth + 1, key.length + 1);
    });
    return `{\n${lines.join(",\n")}\n${end}}`;
  };
  return format(value, 0, 0);
}

/** True when a value is an object or array that `formatJson` would spread over several lines. */
export const isMultiline = (value: unknown, width?: number) => formatJson(value, width).includes("\n");
