// Pure helpers for turning a *dragged email* into an ingestible text document.
//
// Dragging a message out of the Outlook desktop app rarely lands a real file in
// the browser: most Outlook flavours only expose the message as `text/html`
// (the rendered body, sometimes with a From/Sent/Subject header block) plus
// `text/plain` (often just the subject). Rather than parse the binary `.msg`,
// we read those text payloads and build a clean Markdown doc that flows through
// the existing knowledge-base ingest pipeline unchanged.
//
// Free of DOM/chrome.* so it unit-tests in Node; the browser glue that reads a
// DataTransfer and wraps the result in a File lives in sidebar/dropCapture.ts.

import { EMAIL_DROP_HTML, htmlToText } from './htmlToText';

export interface ParsedEmail {
  subject?: string;
  from?: string;
  date?: string;
  /** Readable message body (HTML stripped), used as the document text. */
  body: string;
  /** Short one-line preview for the "confirm what you caught" card. */
  snippet: string;
}

/**
 * Convert an HTML fragment to readable plain text — no DOM, so it's pure and
 * safe (the markup is never inserted into a live document). Good enough for
 * search/ingest and a preview; not a full renderer. Linear-time on hostile
 * input (see htmlToText.ts).
 */
export function stripHtml(html: string): string {
  return htmlToText(html, EMAIL_DROP_HTML);
}

/** First matching `Label: value` line (EN + FR labels), searched case-insensitively. */
function headerValue(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im');
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return undefined;
}

/** A short `text/plain` that isn't the body's first line is usually the subject. */
function subjectFromPlain(plain: string, body: string): string | undefined {
  const p = plain.trim();
  if (!p || p.includes('\n') || p.length > 200) return undefined;
  if (p === body.split('\n')[0]?.trim()) return undefined;
  return p;
}

function makeSnippet(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200).trimEnd()}…` : collapsed;
}

/**
 * Parse a dragged email's `text/html` + `text/plain` payloads into structured
 * fields. Every field is best-effort: Outlook flavours differ wildly, so we
 * extract what's reliably present and leave the rest undefined.
 */
export function parseDraggedEmail(html: string, plain: string): ParsedEmail {
  const fromHtml = stripHtml(html);
  const body = fromHtml || plain.replace(/\r/g, '').trim();
  const headerSource = `${plain}\n${body}`;

  const subject = headerValue(headerSource, ['Subject', 'Objet']) ?? subjectFromPlain(plain, body);
  const from = headerValue(headerSource, ['From', 'De', 'Sender', 'Expéditeur']);
  const date = headerValue(headerSource, ['Sent', 'Date', 'Envoyé']);

  return { subject, from, date, body, snippet: makeSnippet(body) };
}

/**
 * A strong signal that clipboard/drag text is an *email* rather than arbitrary
 * rich text: a copied Outlook message carries a From/Sent (or Date) header line.
 * Used to decide whether to treat a paste as "add this email" vs. a normal paste
 * into the composer, so ordinary rich-text pastes are never hijacked.
 */
export function looksLikeEmail(html: string, plain: string): boolean {
  const p = parseDraggedEmail(html, plain);
  return Boolean(p.from || p.date);
}

/** A safe, readable filename derived from the subject (no path/OS-illegal chars). */
export function emailFileName(p: ParsedEmail): string {
  const base =
    (p.subject ?? 'email')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'email';
  return `${base}.md`;
}

/** The Markdown document ingested into the knowledge base. */
export function emailMarkdown(p: ParsedEmail): string {
  const lines: string[] = [`# ${p.subject ?? 'Email'}`, ''];
  const meta: string[] = [];
  if (p.from) meta.push(`**From:** ${p.from}`);
  if (p.date) meta.push(`**Date:** ${p.date}`);
  if (meta.length) {
    lines.push(meta.join('  \n'), '');
  }
  lines.push('---', '', p.body, '');
  return lines.join('\n');
}
