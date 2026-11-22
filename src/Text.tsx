/**
 * Description text with `backticks` shown as inline code. Everything else is kept as plain text
 * (line breaks are preserved by the surrounding `white-space: pre-wrap`).
 */
export function Text({ children }: { children: string }) {
  // Odd parts of the split are the text between a pair of backticks; an unmatched backtick stays as is.
  const parts = children.split(/`([^`\n]+)`/);
  return <>{parts.map((part, i) => (i % 2 === 1 ? <code class="inline-code" key={i}>{part}</code> : part))}</>;
}
