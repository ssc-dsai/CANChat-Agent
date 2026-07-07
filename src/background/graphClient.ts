// =============================================================================
// Cookie-free Microsoft Graph HTTP client — a bearer-token fetch wrapper shared
// by mail indexing, live mail search, calendar search, and draft creation.
// Mirrors owaClient.ts's retry/backoff pattern (429/5xx retried with
// Retry-After, capped at 30s, up to 6 attempts) so Graph throttling behaves the
// same way the OWA path did.
// =============================================================================

/** Thrown when the access token is rejected by Graph despite looking unexpired locally. */
export class GraphSessionError extends Error {}

/**
 * Fetch a Graph URL with the bearer token, retrying 429/5xx with backoff.
 * Returns the raw Response so callers can `.json()` (GET pages, POST 201
 * responses) as needed. Throws `GraphSessionError` on 401 (token rejected
 * server-side — reconnect needed) rather than retrying.
 */
export async function graphRequest(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
    } catch (err) {
      throw new Error(`Could not reach Microsoft Graph: ${String(err)}`);
    }
    if (res.ok) return res;
    if (res.status === 401) {
      throw new GraphSessionError('Your Microsoft 365 session has expired. Reconnect the mailbox in Settings and retry.');
    }
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= 6) {
      const body = await res.text().catch(() => '');
      throw new Error(`Graph request failed (HTTP ${res.status}). ${body.slice(0, 200)}`.trim());
    }
    const retryAfter = Number(res.headers.get('Retry-After')) || 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(30, retryAfter) * 1000));
  }
}

/** GET a Graph URL and parse the JSON body. */
export async function graphGet<T = unknown>(url: string, token: string): Promise<T> {
  const res = await graphRequest(url, token, {
    headers: { Prefer: 'outlook.body-content-type="text", outlook.timezone="UTC"' },
  });
  return (await res.json()) as T;
}

/** POST a JSON body to a Graph URL and parse the JSON response. */
export async function graphPostJson<T = unknown>(url: string, token: string, body: unknown): Promise<T> {
  const res = await graphRequest(url, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}
