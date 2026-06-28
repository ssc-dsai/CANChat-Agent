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
  buildGetItemBody,
  parseFindItem,
  parseFolders,
  parseGetItem,
  type FindItemPage,
  type OwaFolder,
  type OwaMessage,
} from '../shared/owaMail';

/** How many message ids a single FindItem page requests. */
export const FIND_PAGE_SIZE = 100;
/** How many full messages a single GetItem batch fetches. */
export const GET_BATCH_SIZE = 20;

/** Thrown when there's no usable Outlook web session to ride on. */
export class OwaSessionError extends Error {}

/** Read the OWA anti-CSRF token from the session cookies, or throw. */
export async function readCanary(base: string): Promise<string> {
  let value: string | undefined;
  try {
    const cookie = await chrome.cookies.get({ url: base, name: 'X-OWA-CANARY' });
    value = cookie?.value ?? undefined;
  } catch {
    // cookies permission missing or cookie unreadable — fall through to the throw.
  }
  if (!value) {
    throw new OwaSessionError(
      `No Outlook session found at ${base}. Open Outlook on the web, sign in, then try again.`,
    );
  }
  return value;
}

/**
 * POST one EWS-over-JSON action to `service.svc` with the session cookies and
 * canary, retrying 429/5xx with backoff (EWS throttling). Returns parsed JSON.
 */
async function owaPost(base: string, action: string, canary: string, requestBody: unknown): Promise<unknown> {
  const url = `${base.replace(/\/+$/, '')}/owa/service.svc?action=${action}&app=Mail`;
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
