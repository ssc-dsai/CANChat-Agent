// =============================================================================
// Cookie-session Outlook client — talks to OWA's internal `service.svc` EWS-over-
// JSON endpoint using the user's EXISTING Outlook-on-the-web sign-in. No Microsoft
// Graph, no OAuth, no Azure app: the browser attaches the session cookies
// (`credentials: 'include'`) and we satisfy CSRF with the `X-OWA-CANARY` cookie.
// The request/response shapes are built/parsed by the pure helpers in
// shared/owaMail.ts; this file just does the authenticated POSTs (with throttling
// backoff). Mirrors the canary+headers pattern in browserToolAdapter.outlookMailSearch.
// =============================================================================

import {
  buildFindFolderBody,
  buildFindItemBody,
  buildCreateDraftBody,
  buildGetItemBody,
  parseCreateDraft,
  parseFindItem,
  parseFolders,
  parseGetItem,
  type FindItemPage,
  type OwaDraftInput,
  type OwaDraftResult,
  type OwaFolder,
  type OwaMessage,
} from '../shared/owaMail';
import { buildGetCalendarViewBody, parseCalendarView, type OwaCalendarEvent } from '../shared/owaCalendar';

/** How many message ids a single FindItem page requests. */
export const FIND_PAGE_SIZE = 100;
/** How many full messages a single GetItem batch fetches. */
export const GET_BATCH_SIZE = 20;

/** Thrown when there's no usable Outlook web session to ride on. */
export class OwaSessionError extends Error {}

async function readCanaryCookie(base: string): Promise<string | undefined> {
  try {
    const cookie = await chrome.cookies.get({ url: base, name: 'X-OWA-CANARY' });
    return cookie?.value ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * OWA only issues the X-OWA-CANARY token after the web app/session has been
 * touched. If Microsoft 365 cookies exist but the canary is absent, quietly hit
 * Outlook's own app routes with credentials so the endpoint tools can bootstrap
 * the session without asking the user to manually open Outlook first.
 */
async function bootstrapOwaSession(base: string): Promise<void> {
  const root = base.replace(/\/+$/, '');
  for (const path of ['/mail/', '/owa/']) {
    try {
      await fetch(`${root}${path}`, {
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
      });
    } catch {
      // Best effort; the final cookie read below determines whether it worked.
    }
  }
}

/** Read the OWA anti-CSRF token from the session cookies, or throw. */
export async function readCanary(base: string): Promise<string> {
  const clean = base.replace(/\/+$/, '');
  let value = await readCanaryCookie(clean);
  if (!value) {
    await bootstrapOwaSession(clean);
    value = await readCanaryCookie(clean);
  }
  if (!value) {
    throw new OwaSessionError(
      `Could not establish an Outlook endpoint session at ${clean}. Sign in to Outlook/Microsoft 365 once, then retry.`,
    );
  }
  return value;
}

/**
 * POST one EWS-over-JSON action to `service.svc` with the session cookies and
 * canary, retrying 429/5xx with backoff (EWS throttling). Returns parsed JSON.
 */
async function owaPost(
  base: string,
  action: string,
  canary: string,
  requestBody: unknown,
  app: 'Mail' | 'Calendar' = 'Mail',
): Promise<unknown> {
  const url = `${base.replace(/\/+$/, '')}/owa/service.svc?action=${action}&app=${app}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
          Action: action,
          'X-OWA-CANARY': canary,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      throw new Error(`Could not reach Outlook at ${base}: ${String(err)}`);
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new Error(`Outlook ${action} returned a non-JSON response (the OWA endpoint may have changed).`);
      }
    }
    // 440/401 = session expired; surface as a session error so the UI can prompt re-sign-in.
    if (res.status === 401 || res.status === 440) {
      throw new OwaSessionError('Your Outlook session has expired. Open Outlook on the web and sign in again.');
    }
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= 6) {
      throw new Error(`Outlook ${action} failed (HTTP ${res.status}). The OWA endpoint may have changed.`);
    }
    const retryAfter = Number(res.headers.get('Retry-After')) || 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(30, retryAfter) * 1000));
  }
}

/** Enumerate every folder in the mailbox (deep). */
export async function owaFindFolders(base: string, canary: string): Promise<OwaFolder[]> {
  return parseFolders(await owaPost(base, 'FindFolder', canary, buildFindFolderBody()));
}

/** Fetch one page of message ids (newest-first) from a folder. */
export async function owaFindItemsPage(
  base: string,
  canary: string,
  folderId: string,
  offset: number,
): Promise<FindItemPage> {
  return parseFindItem(await owaPost(base, 'FindItem', canary, buildFindItemBody(folderId, offset, FIND_PAGE_SIZE)));
}

/** Fetch full plain-text messages for a batch of ids. */
export async function owaGetItems(base: string, canary: string, ids: string[]): Promise<OwaMessage[]> {
  if (ids.length === 0) return [];
  return parseGetItem(await owaPost(base, 'GetItem', canary, buildGetItemBody(ids)));
}

/** Create a saved Outlook draft. This does not send the message. */
export async function owaCreateDraft(
  base: string,
  canary: string,
  draft: OwaDraftInput,
): Promise<OwaDraftResult> {
  return parseCreateDraft(await owaPost(base, 'CreateItem', canary, buildCreateDraftBody(draft)), base);
}

/** Fetch calendar events in a time window from the default calendar. */
export async function owaGetCalendarView(
  base: string,
  canary: string,
  start: string,
  end: string,
  includeBody = true,
): Promise<OwaCalendarEvent[]> {
  return parseCalendarView(
    await owaPost(base, 'GetCalendarView', canary, buildGetCalendarViewBody(start, end, includeBody), 'Calendar'),
    base,
  );
}
