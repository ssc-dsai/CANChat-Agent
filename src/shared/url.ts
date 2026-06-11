/** Normalize a hostname or URL to a bare lowercase host without a leading www. */
export function normalizeHost(input: string): string {
  let host = input.trim().toLowerCase();
  // Strip scheme and path if a full URL (or partial) was given.
  host = host.replace(/^[a-z]+:\/\//, '');
  host = host.split('/')[0];
  host = host.split('?')[0];
  host = host.split('#')[0];
  host = host.replace(/^www\./, '');
  return host;
}

/** True when an active tab's host belongs to a playbook's origin (incl. subdomains). */
export function hostMatches(tabHost: string, origin: string): boolean {
  const a = normalizeHost(tabHost);
  const b = normalizeHost(origin);
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b);
}
