/**
 * The tiny inline markup the "How it works" paragraphs are written in (SEN-181),
 * so the copy stays plain strings that are easy to edit:
 *
 * - `[label](/route)` — a link to a screen in the app; `[label](#anchor)` — a
 *   jump to another question on the same page.
 * - `` `text` `` — a literal: a salt, a key label, a contract field.
 *
 * Nothing nests and nothing else is special. Pure, so `content.test.ts` runs
 * it under plain node.
 */

export type Span =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

const TOKEN = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g;

export function parseParagraph(source: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    const at = match.index;
    if (at > last) spans.push({ kind: 'text', text: source.slice(last, at) });
    const [whole, label, href, code] = match;
    if (code !== undefined) spans.push({ kind: 'code', text: code });
    else if (label !== undefined && href !== undefined)
      spans.push({ kind: 'link', text: label, href });
    last = at + whole.length;
  }
  if (last < source.length) spans.push({ kind: 'text', text: source.slice(last) });
  return spans;
}

/** Every link target a paragraph names, in order. */
export function linksOf(source: string): string[] {
  return parseParagraph(source).flatMap((span) => (span.kind === 'link' ? [span.href] : []));
}
