// =============================================================================
// AWS Signature Version 4 request signing, implemented with the Web Crypto API
// (no aws-sdk dependency — this service worker has no subprocess/Node runtime
// to run the SDK's credential provider chain anyway). The only caller is
// adapters/bedrockConverse.ts: every other protocol authenticates with a
// simple bearer/API-key header, but Bedrock's runtime API requires a signed
// request. Only static (or STS-issued, via an optional session token)
// credentials are supported — there is no IAM Identity Center/SSO flow here.
// See https://docs.aws.amazon.com/general/latest/gr/sigv4-signing.html.
// =============================================================================

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

/** `20240115T120000Z` (dateTime) and its first 8 chars (date), per SigV4's ISO8601-basic format. */
function amzDate(now: Date): { date: string; dateTime: string } {
  const dateTime = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { date: dateTime.slice(0, 8), dateTime };
}

/**
 * SigV4 canonical URI for non-S3 services: the already-encoded request path
 * with every segment URI-encoded a second time (`%3A` → `%253A`), while the
 * `/` separators are kept. The URL's own pathname is single-encoded, which is
 * what goes on the wire; signing that as-is yields a signature mismatch (403)
 * whenever a segment contains a reserved character, e.g. the `:` in Bedrock
 * model IDs like `anthropic.claude-haiku-4-5-20251001-v1:0`.
 */
export function canonicalUri(pathname: string): string {
  if (!pathname) return '/';
  return pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** STS-issued temporary credentials only. Absent for static (long-lived) credentials. */
  sessionToken?: string;
}

/**
 * Sign one request for AWS Signature Version 4. Returns the headers to add to
 * the fetch call (`host`, `x-amz-date`, `Authorization`, and — when a session
 * token is set — `x-amz-security-token`). `url` must already be the exact URL
 * that will be fetched (no query string is needed for Bedrock's Converse API).
 */
export async function signRequest(
  method: string,
  url: string,
  body: string,
  region: string,
  service: string,
  credentials: SigV4Credentials,
): Promise<Record<string, string>> {
  const { hostname, pathname, search } = new URL(url);
  const { date, dateTime } = amzDate(new Date());
  const payloadHash = await sha256Hex(body);

  const headersToSign: Record<string, string> = { host: hostname, 'x-amz-date': dateTime };
  if (credentials.sessionToken) headersToSign['x-amz-security-token'] = credentials.sessionToken;

  // Header names must be signed in sorted order; SigV4 requires lowercase names here.
  const signedHeaderNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headersToSign[name]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    canonicalUri(pathname),
    search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateTime,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // `host` was only needed to compute the signature — fetch() sets the real
  // Host header itself (and refuses to let callers override it), so it's
  // deliberately left out of the headers actually sent.
  const result: Record<string, string> = { 'x-amz-date': dateTime, Authorization: authorization };
  if (credentials.sessionToken) result['x-amz-security-token'] = credentials.sessionToken;
  return result;
}
