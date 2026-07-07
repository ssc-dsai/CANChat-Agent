// Pure Microsoft Graph mail helpers: query/body builders and response parsers for
// (1) whole-mailbox indexing (paging + message→RAG-doc projection), (2) live mail
// search (the mail half of microsoft365_search), and (3) draft creation
// (draft_email). No chrome.* / network here — the authenticated fetches live in
// background/mailIngest.ts and background/browserToolAdapter.ts.

import { clampTop, type M365SearchFilters } from './microsoftSearch';

/** The single repo that holds the indexed Office 365 mailbox. */
export const MAIL_REPO = '📧 Mailbox';

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const MESSAGE_SELECT = 'id,subject,from,toRecipients,receivedDateTime,webLink,body,bodyPreview';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface EmailAddress {
  name?: string;
  address?: string;
}

function formatEmailAddress(a?: EmailAddress): string {
  if (!a) return '';
  if (a.name && a.address && a.name !== a.address) return `${a.name} <${a.address}>`;
  return a.address || a.name || '';
}

/** Escape a value for embedding in an OData string literal (single quotes double up). */
function odataEscape(s: string): string {
  return s.replace(/'/g, "''");
}

// ----- Whole-mailbox indexing (paging) -----

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
    .map((r) => formatEmailAddress(r.emailAddress))
    .filter(Boolean)
    .join(', ');
  const date = m.receivedDateTime ?? '';
  let body = m.body?.content ?? m.bodyPreview ?? '';
  if (m.body?.contentType?.toLowerCase() === 'html') body = htmlToText(body);
  const header = `From: ${formatEmailAddress(m.from?.emailAddress)}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}`;
  return {
    id: m.id,
    subject,
    url: m.webLink || 'https://outlook.office.com/mail/',
    mtime: date ? Date.parse(date) || 0 : 0,
    text: `${header}\n\n${body.trim()}`.trim(),
  };
}

// ----- Live mail search (microsoft365_search's mail half) -----
//
// Graph's $filter supports contains()/substring matching on subject and sender,
// combined with a receivedDateTime range — a solid structured-field search, but
// NOT full-text across the message body the way OWA's AQS FindItem search was.
// There is no distinct "relevance" ranking available without $search (which has
// its own combination restrictions with $filter); both orderBy values sort by
// receivedDateTime desc here.

export interface GraphMailSearchHit {
  subject: string;
  from?: string;
  received?: string;
  url?: string;
  preview?: string;
}

/** Build the `$filter` clause for a mail search from the shared M365 filter shape. */
export function buildGraphMailFilter(f: M365SearchFilters): string {
  const clauses: string[] = [];
  const query = (f.query ?? '').trim();
  if (query) clauses.push(`contains(subject,'${odataEscape(query)}')`);

  const from = (f.from ?? '').trim();
  if (from) {
    const esc = odataEscape(from);
    clauses.push(`(contains(from/emailAddress/name,'${esc}') or contains(from/emailAddress/address,'${esc}'))`);
  }

  const since = (f.since ?? '').trim();
  if (ISO_DATE.test(since)) clauses.push(`receivedDateTime ge ${since}T00:00:00Z`);
  const until = (f.until ?? '').trim();
  if (ISO_DATE.test(until)) clauses.push(`receivedDateTime le ${until}T23:59:59Z`);

  return clauses.join(' and ');
}

/** Build the `/me/messages` search URL (structured $filter, no free-text $search). */
export function buildGraphMailSearchUrl(f: M365SearchFilters): string {
  const u = new URL(`${GRAPH}/me/messages`);
  u.searchParams.set('$select', 'id,subject,from,receivedDateTime,bodyPreview,webLink');
  u.searchParams.set('$top', String(clampTop(f.top)));
  u.searchParams.set('$orderby', 'receivedDateTime desc');
  const filter = buildGraphMailFilter(f);
  if (filter) u.searchParams.set('$filter', filter);
  return u.toString();
}

/** Project a `/me/messages` search page into the shape microsoft365_search returns. */
export function parseGraphMailSearch(json: unknown): GraphMailSearchHit[] {
  const value = (json as { value?: GraphMessage[] })?.value;
  return (Array.isArray(value) ? value : []).map((m): GraphMailSearchHit => ({
    subject: (m.subject || '(no subject)').trim(),
    from: formatEmailAddress(m.from?.emailAddress) || undefined,
    received: m.receivedDateTime || undefined,
    url: m.webLink || undefined,
    preview: typeof m.bodyPreview === 'string' ? m.bodyPreview.trim() || undefined : undefined,
  }));
}

// ----- Draft creation (draft_email) -----
//
// Graph's `importance` enum is lowercase ('low'|'normal'|'high'), unlike the
// tool-facing 'Low'|'Normal'|'High' kept for schema/backward compatibility.

export interface GraphDraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyType?: 'Text' | 'HTML';
  importance?: 'Low' | 'Normal' | 'High';
}

export interface GraphDraftResult {
  id: string;
  changeKey?: string;
  url: string;
}

function graphRecipients(addresses?: string[]): Array<{ emailAddress: { address: string } }> | undefined {
  const out = (addresses ?? [])
    .map((a) => a.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
  return out.length ? out : undefined;
}

/** Build the `POST /me/messages` body that creates (never sends) a draft. */
export function buildGraphDraftMessage(draft: GraphDraftInput): unknown {
  const msg: Record<string, unknown> = {
    subject: draft.subject,
    body: { contentType: draft.bodyType === 'HTML' ? 'HTML' : 'Text', content: draft.body },
    importance: (draft.importance ?? 'Normal').toLowerCase(),
  };
  const to = graphRecipients(draft.to);
  const cc = graphRecipients(draft.cc);
  const bcc = graphRecipients(draft.bcc);
  if (to) msg.toRecipients = to;
  if (cc) msg.ccRecipients = cc;
  if (bcc) msg.bccRecipients = bcc;
  return msg;
}

/** `POST` here creates a draft in the default mailbox (never sends). */
export function createMessageUrl(): string {
  return `${GRAPH}/me/messages`;
}

/** Graph returns the created Message resource directly (no envelope). */
export function parseGraphDraftResponse(json: unknown): GraphDraftResult {
  const m = json as { id?: string; changeKey?: string; webLink?: string };
  if (!m?.id) throw new Error('Graph did not return a draft message id.');
  return { id: m.id, changeKey: m.changeKey, url: m.webLink || 'https://outlook.office.com/mail/' };
}
