// Pure helpers for reading Outlook calendar events through OWA's service.svc
// endpoint. Authenticated fetches live in background/owaClient.ts; this file only
// builds request bodies and normalizes defensive response parsing.

const SERVER_VERSION = 'Exchange2013';

function header(): unknown {
  return { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: SERVER_VERSION };
}

function propUri(fieldUri: string): unknown {
  return { __type: 'PropertyUri:#Exchange', FieldURI: fieldUri };
}

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

export interface OwaCalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  location?: string;
  organizer?: string;
  requiredAttendees?: string[];
  optionalAttendees?: string[];
  bodyPreview?: string;
  bodyText?: string;
  teamsUrl?: string;
  url: string;
}

export function buildGetCalendarViewBody(start: string, end: string, includeBody = true): unknown {
  return {
    __type: 'GetCalendarViewJsonRequest:#Exchange',
    Header: header(),
    Body: {
      __type: 'GetCalendarViewRequest:#Exchange',
      CalendarView: {
        __type: 'CalendarView:#Exchange',
        StartDate: start,
        EndDate: end,
      },
      ItemShape: {
        __type: 'ItemResponseShape:#Exchange',
        BaseShape: 'IdOnly',
        ...(includeBody ? { BodyType: 'Text' } : {}),
        AdditionalProperties: [
          propUri('Subject'),
          propUri('Start'),
          propUri('End'),
          propUri('Location'),
          propUri('Organizer'),
          propUri('RequiredAttendees'),
          propUri('OptionalAttendees'),
          propUri('Preview'),
          ...(includeBody ? [propUri('Body')] : []),
        ],
      },
      ParentFolderIds: [{ __type: 'DistinguishedFolderId:#Exchange', Id: 'calendar' }],
    },
  };
}

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

function bodyToText(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() || undefined;
  const v = (body as { Value?: string })?.Value;
  if (typeof v !== 'string') return undefined;
  const text = /<[a-z][\s\S]*>/i.test(v) ? htmlToText(v) : v.trim();
  return text || undefined;
}

function attendees(raw: unknown): string[] | undefined {
  const list = Array.isArray(raw) ? raw : [];
  const out = list
    .map((r) => mailboxAddr((r as { Mailbox?: Mailbox })?.Mailbox))
    .filter(Boolean);
  return out.length ? out : undefined;
}

function locationText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.trim() || undefined;
  const displayName = (raw as { DisplayName?: string })?.DisplayName;
  return typeof displayName === 'string' && displayName.trim() ? displayName.trim() : undefined;
}

export function extractTeamsUrl(text: string): string | undefined {
  const match = /https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|[^\s<>()"']+\.teams\.microsoft\.com)\/[^\s<>()"']+/i.exec(text);
  return match?.[0]?.replace(/[.,;]+$/, '');
}

export function calendarEventUrl(base: string, id: string): string {
  const b = base.replace(/\/+$/, '');
  return `${b}/calendar/item/${encodeURIComponent(id)}`;
}

export function parseCalendarView(json: unknown, base: string): OwaCalendarEvent[] {
  const responseItems = (
    json as { Body?: { ResponseMessages?: { Items?: Array<{ RootFolder?: { Items?: unknown[] }; Items?: unknown[] }> } } }
  )?.Body?.ResponseMessages?.Items;
  const rawItems = (Array.isArray(responseItems) ? responseItems : []).flatMap((rm) => {
    const rootItems = rm.RootFolder?.Items;
    if (Array.isArray(rootItems)) return rootItems;
    return Array.isArray(rm.Items) ? rm.Items : [];
  });

  return rawItems
    .map((raw): OwaCalendarEvent => {
      const it = raw as {
        ItemId?: { Id?: string };
        Subject?: string;
        Start?: string;
        End?: string;
        Location?: unknown;
        Organizer?: { Mailbox?: Mailbox };
        RequiredAttendees?: unknown;
        OptionalAttendees?: unknown;
        Preview?: string;
        Body?: unknown;
        OnlineMeetingUrl?: string;
        JoinOnlineMeetingUrl?: string;
      };
      const bodyText = bodyToText(it.Body);
      const location = locationText(it.Location);
      const haystack = [bodyText, location, it.OnlineMeetingUrl, it.JoinOnlineMeetingUrl].filter(Boolean).join('\n');
      const id = it.ItemId?.Id ?? '';
      return {
        id,
        subject: (typeof it.Subject === 'string' ? it.Subject.trim() : '') || '(no subject)',
        start: typeof it.Start === 'string' ? it.Start : '',
        end: typeof it.End === 'string' ? it.End : '',
        location,
        organizer: mailboxAddr(it.Organizer?.Mailbox) || undefined,
        requiredAttendees: attendees(it.RequiredAttendees),
        optionalAttendees: attendees(it.OptionalAttendees),
        bodyPreview: typeof it.Preview === 'string' && it.Preview.trim() ? it.Preview.trim() : undefined,
        bodyText,
        teamsUrl: extractTeamsUrl(haystack),
        url: calendarEventUrl(base, id),
      };
    })
    .filter((it) => it.id && it.start && it.end);
}

export function eventMatchesQuery(event: OwaCalendarEvent, query?: string): boolean {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    event.subject,
    event.location,
    event.organizer,
    ...(event.requiredAttendees ?? []),
    ...(event.optionalAttendees ?? []),
    event.bodyPreview,
    event.bodyText,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}
