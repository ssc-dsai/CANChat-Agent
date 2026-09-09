// Parse a `.msg` (Outlook binary OLE Compound File) into the same ParsedEmail shape
// the drag/paste and .eml paths use. `.msg` is the classic way to save a message
// from Outlook desktop (File → Save As) and is common on Windows. The file is a
// binary OLE2 CFB container, so we decode it with a lightweight JS CFB parser
// (@kenjiuno/msgreader) rather than the text-based RFC-822 parser used for .eml.
//
// Pure (no chrome.*, no DOM) so it unit-tests in Node/jsdom; the browser glue
// that reads a File's ArrayBuffer and wraps the result in a synthetic File lives
// in sidebar/dropCapture.ts, parallel to .eml.

import MsgReader from '@kenjiuno/msgreader';
import { stripHtml, type ParsedEmail } from './emailDrop';

function makeSnippet(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200).trimEnd()}…` : collapsed;
}

function formatFrom(data: Record<string, unknown>): string | undefined {
  const name = typeof data.senderName === 'string' ? data.senderName.trim() : '';
  const email = typeof data.senderEmail === 'string' ? data.senderEmail.trim() : '';
  const smtp =
    typeof data.senderSmtpAddress === 'string' ? (data.senderSmtpAddress as string).trim() : '';
  const addr = email || smtp;
  if (name && addr && name !== addr) return `${name} <${addr}>`;
  if (addr) return addr;
  if (name) return name;
  return undefined;
}

function formatDate(data: Record<string, unknown>): string | undefined {
  const candidates = [
    data.messageDeliveryTime,
    data.clientSubmitTime,
    data.creationTime,
    data.lastModificationTime,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  if (typeof data.headers === 'string' && data.headers.trim()) {
    const m = data.headers.match(/^Date:\s*(.+)$/im);
    if (m) return m[1].trim();
  }
  return undefined;
}

function attachmentsNote(data: Record<string, unknown>): string {
  const atts = data.attachments;
  if (!Array.isArray(atts) || atts.length === 0) return '';
  const names = atts
    .map((a: Record<string, unknown>) => {
      const n =
        (typeof a.fileName === 'string' && a.fileName) ||
        (typeof a.fileNameShort === 'string' && a.fileNameShort) ||
        (typeof a.name === 'string' && a.name) ||
        '';
      return n.trim();
    })
    .filter(Boolean);
  if (names.length === 0) return '';
  return `\n\nAttachments: ${names.join(', ')}`;
}

/**
 * Parse a raw `.msg` ArrayBuffer into structured email fields.
 * Throws on unsupported/encrypted/malformed files so callers can surface a
 * user-facing error rather than ingesting an empty doc.
 */
export function parseMsg(arrayBuffer: ArrayBuffer): ParsedEmail {
  // Defensive: MsgReader expects an ArrayBuffer; DataView-backed slices still work.
  const reader = new MsgReader(arrayBuffer);
  const data = reader.getFileData() as unknown as Record<string, unknown> & {
    error?: string;
    dataType?: unknown;
  };
  if (data.error) {
    throw new Error(data.error);
  }
  if (data.dataType === null || data.dataType === undefined) {
    throw new Error('Unsupported .msg file');
  }

  const subject =
    typeof data.subject === 'string' && data.subject.trim() ? data.subject.trim() : undefined;
  const from = formatFrom(data);
  const date = formatDate(data);

  let body = '';
  if (typeof data.body === 'string' && data.body.trim()) {
    body = data.body.trim();
  } else if (typeof data.bodyHtml === 'string' && data.bodyHtml.trim()) {
    body = stripHtml(data.bodyHtml).trim();
  } else if (data.html instanceof Uint8Array && data.html.length > 0) {
    try {
      body = stripHtml(new TextDecoder('utf-8').decode(data.html)).trim();
    } catch {
      body = '';
    }
  } else if (data.bodyHtml && typeof data.bodyHtml === 'string') {
    body = stripHtml(String(data.bodyHtml)).trim();
  }

  // If body is still empty but we have a subject, keep the subject so the doc is not empty.
  const note = attachmentsNote(data);
  if (note) body = body ? `${body}${note}` : note.trim();

  // Final fallback: headers may contain the only text for some appointment/meeting msgs.
  if (!body && typeof data.headers === 'string' && data.headers.trim()) {
    body = stripHtml(data.headers).trim();
  }

  return { subject, from, date, body: body.trim(), snippet: makeSnippet(body) };
}
