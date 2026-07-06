// Pure EWS-over-JSON helpers for indexing the mailbox through the user's existing
// Outlook-on-the-web session (no Microsoft Graph, no Azure app registration). These
// build the request envelopes OWA's own `service.svc` accepts and parse its
// responses; the authenticated POSTs live in background/owaClient.ts. No chrome.* /
// network here, so everything is unit-testable.
//
// The request shapes mirror what OWA itself sends (the FindItem body in
// background/browserToolAdapter.ts:outlookMailSearch is the proven template).
// service.svc is undocumented, so parsers are defensive and field names may need
// adjusting against a captured live response.

/** The single repo that holds the indexed Office 365 mailbox. */
export const MAIL_REPO = '📧 Mailbox';

const SERVER_VERSION = 'Exchange2013';

function header(): unknown {
  return { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: SERVER_VERSION };
}

function propUri(fieldUri: string): unknown {
  return { __type: 'PropertyUri:#Exchange', FieldURI: fieldUri };
}

// ----- Folder enumeration (FindFolder, whole mailbox) -----

export interface OwaFolder {
  id: string;
  displayName: string;
  folderClass: string;
}

/** `FindFolder` from the mailbox root, deep traversal → every folder. */
export function buildFindFolderBody(): unknown {
  return {
    __type: 'FindFolderJsonRequest:#Exchange',
    Header: header(),
    Body: {
      __type: 'FindFolderRequest:#Exchange',
      FolderShape: {
        __type: 'FolderResponseShape:#Exchange',
        BaseShape: 'IdOnly',
        AdditionalProperties: [propUri('DisplayName'), propUri('FolderClass')],
      },
      ParentFolderIds: [{ __type: 'DistinguishedFolderId:#Exchange', Id: 'msgfolderroot' }],
      Traversal: 'Deep',
    },
  };
}

export function parseFolders(json: unknown): OwaFolder[] {
  const root = (
    json as { Body?: { ResponseMessages?: { Items?: Array<{ RootFolder?: { Folders?: unknown[] } }> } } }
  )?.Body?.ResponseMessages?.Items?.[0]?.RootFolder?.Folders;
  return (Array.isArray(root) ? root : [])
    .map((raw): OwaFolder => {
      const f = raw as { FolderId?: { Id?: string }; DisplayName?: string; FolderClass?: string };
      return {
        id: f.FolderId?.Id ?? '',
        displayName: typeof f.DisplayName === 'string' ? f.DisplayName : '',
        folderClass: typeof f.FolderClass === 'string' ? f.FolderClass : '',
      };
    })
    .filter((f) => f.id);
}

/**
 * Keep only mail folders (`IPF.Note`) so Calendar/Contacts/Tasks/Notes — which
 * hold no plain-text message body — don't pollute the index. Some containers have
 * an empty class; those return no FindItem results, so excluding them is safe.
 */
export function isMailFolder(f: OwaFolder): boolean {
  return f.folderClass.startsWith('IPF.Note');
}

// ----- Message id paging within a folder (FindItem) -----

export interface OwaItemRef {
  id: string;
  subject?: string;
  received?: string;
  /** receivedDateTime as epoch ms. */
  mtime: number;
}

export interface FindItemPage {
  items: OwaItemRef[];
  /** Total items in the view (for progress / sanity). */
  total: number;
  /** True once this page reaches the end of the folder. */
  includesLast: boolean;
}

/** `FindItem` over an arbitrary folder, id+date only, newest first, paged. */
export function buildFindItemBody(folderId: string, offset: number, max: number): unknown {
  return {
    __type: 'FindItemJsonRequest:#Exchange',
    Header: header(),
    Body: {
      __type: 'FindItemRequest:#Exchange',
      ItemShape: {
        __type: 'ItemResponseShape:#Exchange',
        BaseShape: 'IdOnly',
        AdditionalProperties: [propUri('Subject'), propUri('DateTimeReceived')],
      },
      ParentFolderIds: [{ __type: 'FolderId:#Exchange', Id: folderId }],
      Traversal: 'Shallow',
      Paging: {
        __type: 'IndexedPageView:#Exchange',
        BasePoint: 'Beginning',
        Offset: Math.max(0, Math.floor(offset)),
        MaxEntriesReturned: Math.max(1, Math.floor(max)),
      },
      SortOrder: [
        {
          __type: 'SortResults:#Exchange',
          Order: 'Descending',
          Path: propUri('DateTimeReceived'),
        },
      ],
    },
  };
}

export function parseFindItem(json: unknown): FindItemPage {
  const root = (
    json as {
      Body?: {
        ResponseMessages?: {
          Items?: Array<{
            RootFolder?: { Items?: unknown[]; TotalItemsInView?: number; IncludesLastItemInRange?: boolean | string };
          }>;
        };
      };
    }
  )?.Body?.ResponseMessages?.Items?.[0]?.RootFolder;
  const rawItems = root?.Items;
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map((raw): OwaItemRef => {
      const it = raw as { ItemId?: { Id?: string }; Subject?: string; DateTimeReceived?: string };
      const received = typeof it.DateTimeReceived === 'string' ? it.DateTimeReceived : undefined;
      return {
        id: it.ItemId?.Id ?? '',
        subject: typeof it.Subject === 'string' ? it.Subject : undefined,
        received,
        mtime: received ? Date.parse(received) || 0 : 0,
      };
    })
    .filter((it) => it.id);
  const total = Number(root?.TotalItemsInView ?? items.length);
  const includesLast = root?.IncludesLastItemInRange === true || root?.IncludesLastItemInRange === 'true';
  return { items, total, includesLast };
}

// ----- Full message fetch (GetItem, batched) -----

interface Mailbox {
  Name?: string;
  EmailAddress?: string;
}

function mailboxAddr(mb?: Mailbox): string {
  if (!mb) return '';
  const name = typeof mb.Name === 'string' ? mb.Name : '';
  const email = typeof mb.EmailAddress === 'string' ? mb.EmailAddress : '';
  if (name && email && name !== email) return `${name} <${email}>`;
  return email || name || '';
}

export interface OwaMessage {
  id: string;
  subject: string;
  from: string;
  to: string;
  received: string;
  mtime: number;
  bodyText: string;
}

/** `GetItem` for a batch of ids, plain-text body. */
export function buildGetItemBody(ids: string[]): unknown {
  return {
    __type: 'GetItemJsonRequest:#Exchange',
    Header: header(),
    Body: {
      __type: 'GetItemRequest:#Exchange',
      ItemShape: {
        __type: 'ItemResponseShape:#Exchange',
        BaseShape: 'IdOnly',
        BodyType: 'Text',
        AdditionalProperties: [
          propUri('Subject'),
          propUri('DateTimeReceived'),
          propUri('From'),
          propUri('ToRecipients'),
          propUri('Body'),
        ],
      },
      ItemIds: ids.map((id) => ({ __type: 'ItemId:#Exchange', Id: id })),
    },
  };
}

/** Best-effort HTML → text, in case a body comes back as HTML despite BodyType:Text. */
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

function bodyToText(body: unknown): string {
  if (typeof body === 'string') return body;
  const v = (body as { Value?: string })?.Value;
  const text = typeof v === 'string' ? v : '';
  // Defensive: if the server ignored BodyType:Text and returned HTML, strip it.
  return /<[a-z][\s\S]*>/i.test(text) ? htmlToText(text) : text;
}

export function parseGetItem(json: unknown): OwaMessage[] {
  const msgs = (
    json as { Body?: { ResponseMessages?: { Items?: Array<{ Items?: unknown[] }> } } }
  )?.Body?.ResponseMessages?.Items;
  const out: OwaMessage[] = [];
  for (const rm of Array.isArray(msgs) ? msgs : []) {
    const it = (rm as { Items?: unknown[] })?.Items?.[0] as
      | {
          ItemId?: { Id?: string };
          Subject?: string;
          DateTimeReceived?: string;
          From?: { Mailbox?: Mailbox };
          ToRecipients?: Array<{ Mailbox?: Mailbox }>;
          Body?: unknown;
        }
      | undefined;
    if (!it?.ItemId?.Id) continue;
    const received = typeof it.DateTimeReceived === 'string' ? it.DateTimeReceived : '';
    out.push({
      id: it.ItemId.Id,
      subject: (typeof it.Subject === 'string' ? it.Subject.trim() : '') || '(no subject)',
      from: mailboxAddr(it.From?.Mailbox),
      to: (Array.isArray(it.ToRecipients) ? it.ToRecipients : [])
        .map((r) => mailboxAddr(r?.Mailbox))
        .filter(Boolean)
        .join(', '),
      received,
      mtime: received ? Date.parse(received) || 0 : 0,
      bodyText: bodyToText(it.Body),
    });
  }
  return out;
}

// ----- Projection into a RAG document -----

export interface MailDoc {
  /** EWS ItemId — the incremental-sync key (DocMeta.path). */
  id: string;
  subject: string;
  /** OWA deep-link to read the message — clickable in results. */
  url: string;
  /** receivedDateTime as epoch ms (DocMeta.mtime). */
  mtime: number;
  /** Header block + body text, ready to chunk + embed. */
  text: string;
}

/** Build the OWA deep-link that opens a message by its ItemId. */
export function messageUrl(base: string, id: string): string {
  const b = base.replace(/\/+$/, '');
  return `${b}/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`;
}

/** Project a fetched message into a RAG document (header block + body text). */
export function messageToMailDoc(m: OwaMessage, base: string): MailDoc {
  const header = `From: ${m.from}\nTo: ${m.to}\nSubject: ${m.subject}\nDate: ${m.received}`;
  return {
    id: m.id,
    subject: m.subject,
    url: messageUrl(base, m.id),
    mtime: m.mtime,
    text: `${header}\n\n${m.bodyText.trim()}`.trim(),
  };
}
