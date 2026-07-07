// Pure Microsoft Graph calendar helpers for calendar_search: the
// `/me/calendarView` request URL and a defensive response parser. Mirrors
// owaCalendar.ts's output shape exactly (id, subject, start, end, location,
// organizer, attendees, body preview/text, teamsUrl, url) so calendar_search's
// JSON contract to the model is unchanged — only the backend (Graph OAuth
// instead of the OWA session cookie) differs. Authenticated fetches live in
// background/agentRuntime.ts's calendar_search case.
//
// Like OWA's GetCalendarView, this fetches the whole date window in one call
// (no server-side $top) and lets the caller filter/sort/slice client-side —
// calendar windows are small enough (days/weeks) that this doesn't need
// pagination. The caller must set `Prefer: outlook.timezone="UTC"` on the
// fetch so `start`/`end` come back UTC-normalized (Graph's `dateTime` field
// carries no offset of its own — it's local to the paired `timeZone` field).

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** A generous single-page cap — calendar windows are days/weeks, not thousands of events. */
const VIEW_PAGE_SIZE = 250;

const CALENDAR_SELECT =
  'id,subject,start,end,location,organizer,attendees,bodyPreview,body,webLink,onlineMeeting';

interface Mailbox {
  name?: string;
  address?: string;
}

function mailboxAddr(mb?: Mailbox): string {
  if (!mb) return '';
  const name = mb.name ?? '';
  const email = mb.address ?? '';
  if (name && email && name !== email) return `${name} <${email}>`;
  return email || name || '';
}

export interface GraphCalendarEvent {
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

/** Build the `/me/calendarView` URL for a date window. */
export function buildCalendarViewUrl(start: string, end: string, includeBody = true): string {
  const u = new URL(`${GRAPH}/me/calendarView`);
  u.searchParams.set('startDateTime', start);
  u.searchParams.set('endDateTime', end);
  u.searchParams.set('$top', String(VIEW_PAGE_SIZE));
  u.searchParams.set('$orderby', 'start/dateTime');
  u.searchParams.set('$select', includeBody ? CALENDAR_SELECT : CALENDAR_SELECT.replace(',body,', ','));
  return u.toString();
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
  const b = body as { contentType?: string; content?: string } | undefined;
  const content = b?.content;
  if (typeof content !== 'string' || !content.trim()) return undefined;
  const text = b?.contentType?.toLowerCase() === 'html' ? htmlToText(content) : content.trim();
  return text || undefined;
}

/** `dateTime` (no zone suffix) + `timeZone` → a Z-suffixed ISO string, assuming UTC. */
function toIso(field: unknown): string {
  const dt = (field as { dateTime?: string })?.dateTime;
  if (typeof dt !== 'string' || !dt) return '';
  return dt.endsWith('Z') ? dt : `${dt}Z`;
}

export function extractTeamsUrl(text: string): string | undefined {
  const match = /https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|[^\s<>()"']+\.teams\.microsoft\.com)\/[^\s<>()"']+/i.exec(text);
  return match?.[0]?.replace(/[.,;]+$/, '');
}

export function parseCalendarView(json: unknown): GraphCalendarEvent[] {
  const value = (json as { value?: unknown[] })?.value;
  return (Array.isArray(value) ? value : [])
    .map((raw): GraphCalendarEvent => {
      const it = raw as {
        id?: string;
        subject?: string;
        start?: unknown;
        end?: unknown;
        location?: { displayName?: string };
        organizer?: { emailAddress?: Mailbox };
        attendees?: Array<{ emailAddress?: Mailbox; type?: string }>;
        bodyPreview?: string;
        body?: unknown;
        webLink?: string;
        onlineMeeting?: { joinUrl?: string };
      };
      const bodyText = bodyToText(it.body);
      const location = typeof it.location?.displayName === 'string' && it.location.displayName.trim()
        ? it.location.displayName.trim()
        : undefined;
      const attendees = Array.isArray(it.attendees) ? it.attendees : [];
      const required = attendees.filter((a) => a.type !== 'optional').map((a) => mailboxAddr(a.emailAddress)).filter(Boolean);
      const optional = attendees.filter((a) => a.type === 'optional').map((a) => mailboxAddr(a.emailAddress)).filter(Boolean);
      const haystack = [bodyText, location, it.onlineMeeting?.joinUrl].filter(Boolean).join('\n');
      const id = it.id ?? '';
      return {
        id,
        subject: (typeof it.subject === 'string' ? it.subject.trim() : '') || '(no subject)',
        start: toIso(it.start),
        end: toIso(it.end),
        location,
        organizer: mailboxAddr(it.organizer?.emailAddress) || undefined,
        requiredAttendees: required.length ? required : undefined,
        optionalAttendees: optional.length ? optional : undefined,
        bodyPreview: typeof it.bodyPreview === 'string' && it.bodyPreview.trim() ? it.bodyPreview.trim() : undefined,
        bodyText,
        teamsUrl: it.onlineMeeting?.joinUrl || extractTeamsUrl(haystack),
        url: it.webLink || 'https://outlook.office.com/calendar/view/',
      };
    })
    .filter((it) => it.id && it.start && it.end);
}

export function eventMatchesQuery(event: GraphCalendarEvent, query?: string): boolean {
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
