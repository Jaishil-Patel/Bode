import MarkdownIt from "markdown-it";

/*
 * Markdown → HTML for the reflowed reading view.
 *
 * `html: false` makes markdown-it ESCAPE any raw HTML in the source rather than pass it through,
 * so the output contains only markdown-it's own safe tags — no <script>, no event-handler
 * attributes. Combined with markdown-it's built-in link validation (which rejects javascript:
 * and other dangerous URL schemes), the result is safe to inject with innerHTML under Bode's
 * strict CSP, without pulling in a separate sanitizer.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
});

export function renderMarkdown(source: string): string {
  return md.render(source);
}
