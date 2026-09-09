// Turn a drop's DataTransfer into a queue of items for the knowledge-base
// uploader. Two paths:
//   1. Real files (documents/PDFs) — the normal case.
//   2. A dragged *email* with no usable file — read its text/html + text/plain
//      and synthesise a Markdown file (see shared/emailDrop.ts). This is what
//      makes dragging a message out of desktop Outlook work, since Outlook
//      usually exposes only text, not a readable .msg file.
//
// The DataTransfer is only valid *during* the drop event, so every read here is
// synchronous — no awaits between the event and the last `getData`.

import { classifyUpload } from '../shared/uploadFile';
import { emailFileName, emailMarkdown, looksLikeEmail, parseDraggedEmail, type ParsedEmail } from '../shared/emailDrop';
import { parseEml } from '../shared/emlParse';
import { parseMsg } from '../shared/msgParse';

/** Parsed email fields shown on the "confirm what you caught" preview card. */
export interface EmailPreview {
  subject?: string;
  from?: string;
  date?: string;
  snippet: string;
}

/** One queued upload: a file, plus email metadata when it came from a drag. */
export interface DroppedItem {
  file: File;
  email?: EmailPreview;
}

/** Whether a drag carries something we can add (files, or dragged email text). */
export function dragHasContent(types: readonly string[] | undefined): boolean {
  if (!types) return false;
  // text/plain included so an email dragged from an app that exposes only plain
  // text (some Outlook builds) still lights up the overlay; the internal-drag
  // guard keeps in-panel text drags from triggering it.
  return types.includes('Files') || types.includes('text/html') || types.includes('text/plain');
}

/** Human-readable list of what a drop/paste offered — for a "couldn't read it" diagnostic. */
export function describeTypes(dt: DataTransfer | null): string {
  if (!dt) return '';
  const parts = Array.from(dt.types ?? []);
  const files = Array.from(dt.files ?? []);
  if (files.length) parts.push(`files: ${files.map((f) => f.name || f.type || '?').join(', ')}`);
  return parts.join(', ');
}

function safeGetData(dt: DataTransfer, type: string): string {
  try {
    return dt.getData(type) ?? '';
  } catch {
    return '';
  }
}

/** Build a queued item from parsed email fields (synthetic Markdown file + preview). */
function emailItem(parsed: ParsedEmail): DroppedItem {
  const file = new File([emailMarkdown(parsed)], emailFileName(parsed), { type: 'text/markdown' });
  return { file, email: { subject: parsed.subject, from: parsed.from, date: parsed.date, snippet: parsed.snippet } };
}

function isEmlFile(f: File): boolean {
  return /\.eml$/i.test(f.name) || f.type === 'message/rfc822';
}

function isMsgFile(f: File): boolean {
  return /\.msg$/i.test(f.name) || f.type === 'application/vnd.ms-outlook';
}



/**
 * Synchronous capture: supported files, else a dragged/pasted email's text.
 * Used where an async read isn't wanted (the composer paste). Does NOT read
 * `.eml` file contents — use `captureDropFull` for that.
 */
export function captureDrop(dt: DataTransfer | null): DroppedItem[] {
  if (!dt) return [];

  const realFiles = Array.from(dt.files ?? []).filter((f) => classifyUpload(f.name, f.type));
  if (realFiles.length > 0) return realFiles.map((file) => ({ file }));

  // No supported file — try the email/text payloads (e.g. a drag from Outlook).
  const html = safeGetData(dt, 'text/html');
  const plain = safeGetData(dt, 'text/plain');
  if (!html && !plain) return [];

  const parsed = parseDraggedEmail(html, plain);
  if (!parsed.body.trim()) return [];
  return [emailItem(parsed)];
}

/**
 * Full capture including `.eml` files (parsed via RFC-822) — the reliable way to
 * bring an Outlook/Apple Mail message in on macOS (drag it to the Finder to make
 * a `.eml`, then drop that here). Async because reading a file's text is async;
 * every DataTransfer read still happens synchronously before the first await, as
 * the transfer is only valid during the event.
 */
export async function captureDropFull(dt: DataTransfer | null): Promise<DroppedItem[]> {
  if (!dt) return [];
  const allFiles = Array.from(dt.files ?? []);
  const html = safeGetData(dt, 'text/html');
  const plain = safeGetData(dt, 'text/plain');

  const items: DroppedItem[] = allFiles
    .filter((f) => classifyUpload(f.name, f.type))
    .map((file) => ({ file }));
  for (const f of allFiles.filter(isEmlFile)) {
    try {
      const parsed = parseEml(await f.text());
      if (parsed.body.trim() || parsed.subject) items.push(emailItem(parsed));
    } catch {
      // Unreadable .eml — skip it rather than failing the whole drop.
    }
  }
  for (const f of allFiles.filter(isMsgFile)) {
    try {
      const parsed = parseMsg(await f.arrayBuffer());
      if (parsed.body.trim() || parsed.subject) items.push(emailItem(parsed));
    } catch {
      // Unreadable .msg — skip it rather than failing the whole drop.
    }
  }
  if (items.length) return items;

  if (html || plain) {
    const parsed = parseDraggedEmail(html, plain);
    if (parsed.body.trim()) return [emailItem(parsed)];
  }
  return [];
}

/**
 * Turn picked files (from the 📎 / choose-files input) into queue items,
 * parsing any `.eml` into an email document. Async because reading `.eml` text
 * is async; the drag-free path for Outlook on macOS (save the message as `.eml`,
 * then choose it here). Unsupported non-`.eml` files are dropped.
 */
export async function itemsFromFiles(files: File[]): Promise<DroppedItem[]> {
  const items: DroppedItem[] = [];
  for (const f of files) {
    if (isEmlFile(f)) {
      try {
        const parsed = parseEml(await f.text());
        if (parsed.body.trim() || parsed.subject) items.push(emailItem(parsed));
      } catch {
        // Unreadable .eml — skip it.
      }
    } else if (isMsgFile(f)) {
      try {
        const parsed = parseMsg(await f.arrayBuffer());
        if (parsed.body.trim() || parsed.subject) items.push(emailItem(parsed));
      } catch {
        // Unreadable .msg — skip it.
      }
    } else if (classifyUpload(f.name, f.type)) {
      items.push({ file: f });
    }
  }
  return items;
}

/**
 * True when a paste's clipboard clearly holds an *email* (has HTML with a
 * From/Date header). Used so pasting a copied Outlook message into the composer
 * is recognised as "add this email", while ordinary rich-text pastes are left
 * to insert normally. (A `ClipboardEvent.clipboardData` is a DataTransfer.)
 */
export function clipboardIsEmail(cd: DataTransfer | null): boolean {
  if (!cd || !Array.from(cd.types).includes('text/html')) return false;
  return looksLikeEmail(safeGetData(cd, 'text/html'), safeGetData(cd, 'text/plain'));
}
