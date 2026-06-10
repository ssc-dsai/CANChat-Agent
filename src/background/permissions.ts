/**
 * Staged permission checks. Granting happens in the sidebar (permission
 * requests require a user gesture); the background only checks.
 */
export async function hasAllUrlsAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ['<all_urls>'] });
}

export async function hasOriginAccess(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}
