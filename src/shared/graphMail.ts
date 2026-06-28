// Pure helpers for turning Microsoft Graph mail messages into RAG documents:
// the messages-query URL builder and the message→text projection. No chrome.* /
// network, so it is unit-testable; the paging fetch lives in background/mailIngest.ts.

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const MESSAGE_SELECT = 'id,subject,from,toRecipients,receivedDateTime,webLink,body,bodyPreview';

interface EmailAddress {
  name?: string;
  address?: string;
}

export interface GraphMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: EmailAddress };
  toRecipients?: Array<{ emailAddress?: EmailAddress }>;
  receivedDateTime?: string;
  webLink?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
}

/** A Graph `/messages` page: the items plus the opaque next-page link. */
export interface GraphMessagePage {
  value: GraphMessage[];
  '@odata.nextLink'?: string;
}

/**
 * Build the first-page `/me/messages` URL across all folders (= whole mailbox).
 * `since` (ISO `…Z`) enables the high-water-mark incremental refresh. Subsequent
 * pages are fetched via the `@odata.nextLink` Graph returns.
 */
export function buildMessagesUrl(opts: { top?: number; since?: string } = {}): string {
  const u = new URL(`${GRAPH}/me/messages`);
  u.searchParams.set('$select', MESSAGE_SELECT);
  u.searchParams.set('$top', String(Math.min(100, Math.max(1, Math.floor(opts.top ?? 50)))));
  u.searchParams.set('$orderby', 'receivedDateTime desc');
  if (opts.since) u.searchParams.set('$filter', `receivedDateTime gt ${opts.since}`);
  return u.toString();
}

function addr(a?: EmailAddress): string {
  if (!a) return '';
  if (a.name && a.address && a.name !== a.address) return `${a.name} <${a.address}>`;
  return a.address || a.name || '';
}

/** Best-effort HTML → text for messages whose body is HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface MailDoc {
  /** Graph message id — the stable incremental-sync key (DocMeta.path). */
  id: string;
  subject: string;
  /** Outlook webLink — clickable in results. */
  url: string;
  /** receivedDateTime as epoch ms (DocMeta.mtime). */
  mtime: number;
  /** Header block + body text, ready to chunk + embed. */
  text: string;
}

/** Project a Graph message into a RAG document (header block + body text). */
export function messageToDoc(m: GraphMessage): MailDoc {
  const subject = (m.subject || '(no subject)').trim();
  const to = (m.toRecipients ?? [])
    .map((r) => addr(r.emailAddress))
    .filter(Boolean)
    .join(', ');
  const date = m.receivedDateTime ?? '';
  let body = m.body?.content ?? m.bodyPreview ?? '';
  if (m.body?.contentType?.toLowerCase() === 'html') body = htmlToText(body);
  const header = `From: ${addr(m.from?.emailAddress)}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}`;
  return {
    id: m.id,
    subject,
    url: m.webLink || 'https://outlook.office.com/mail/',
    mtime: date ? Date.parse(date) || 0 : 0,
    text: `${header}\n\n${body.trim()}`.trim(),
  };
}
