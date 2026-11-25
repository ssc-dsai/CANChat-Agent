// =============================================================================
// Guard rails for the `run_javascript` tool.
//
// run_javascript runs model-written code in a page's MAIN world with the page's
// full authority (its cookies, storage and same-origin credentials). There is no
// sandbox that keeps that ability while containing the code, so the defences
// are about the human decision instead:
//
//   - scope: only the active tab or a tab in this conversation's tab group, so
//     an injected model can't quietly aim at an unrelated signed-in site;
//   - size: the approval card shows the whole script, so a script must fit;
//   - warnings: flag APIs that send data out or touch credentials, so the user
//     sees them without reading every line.
//
// Detection is a heuristic for the human reader, not a security boundary: code
// can always be obfuscated, which is why obfuscation itself is flagged.
// =============================================================================

/** Longest script the approval card will show in full (and so the longest we run). */
export const MAX_SCRIPT_CHARS = 4000;

/** How long to wait for a page script before giving up on it. */
export const SCRIPT_TIMEOUT_MS = 15000;

export type ScriptWarning =
  | 'network'
  | 'credentials'
  | 'navigation'
  | 'form_submit'
  | 'cross_window'
  | 'dynamic_code';

const WARNING_PATTERNS: Record<ScriptWarning, RegExp[]> = {
  network: [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bsendBeacon\b/,
    /\bWebSocket\b/,
    /\bEventSource\b/,
    /\bRTCPeerConnection\b/,
    /\bnew\s+Image\b/,
    /\.src\s*=(?!=)/,
    /\bimport\s*\(/,
  ],
  credentials: [
    /\bdocument\s*\.\s*cookie\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bindexedDB\b/,
    /\bnavigator\s*\.\s*credentials\b/,
    /\bcookieStore\b/,
  ],
  navigation: [
    /\blocation\s*(\.\s*(href|assign|replace)\b|=(?!=))/,
    /\bwindow\s*\.\s*open\s*\(/,
    /\bhistory\s*\.\s*(push|replace)State\b/,
  ],
  form_submit: [/\.\s*(submit|requestSubmit)\s*\(/],
  cross_window: [/\bpostMessage\s*\(/, /\bBroadcastChannel\b/],
  dynamic_code: [
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /\batob\s*\(/,
    /\bfromCharCode\b/,
    /\\x[0-9a-f]{2}/i,
    /\\u[0-9a-f]{4}/i,
    /\[\s*['"`][^'"`]*['"`]\s*\+/, // obj['fe' + 'tch'] style property building
  ],
};

/** Which risky capabilities a script appears to use, in a stable order. */
export function scriptRiskWarnings(code: string): ScriptWarning[] {
  return (Object.keys(WARNING_PATTERNS) as ScriptWarning[]).filter((kind) =>
    WARNING_PATTERNS[kind].some((re) => re.test(code)),
  );
}

export type ScriptScopeDecision =
  | { ok: true; reason: 'active_tab' | 'conversation_group' }
  | { ok: false; reason: 'out_of_scope' };

/**
 * A script may target the user's active tab (what they are looking at) or a tab
 * in this conversation's tab group (pages the agent opened for this task). Any
 * other tab — another signed-in site the user happens to have open — is off
 * limits, however the request was phrased.
 */
export function scriptTargetScope(
  tab: { id?: number; groupId?: number },
  activeTabId: number | undefined,
  conversationGroupId: number | null,
): ScriptScopeDecision {
  if (tab.id !== undefined && tab.id === activeTabId) return { ok: true, reason: 'active_tab' };
  if (conversationGroupId !== null && conversationGroupId !== -1 && tab.groupId === conversationGroupId) {
    return { ok: true, reason: 'conversation_group' };
  }
  return { ok: false, reason: 'out_of_scope' };
}

/** Origin of a URL, or undefined when it has none (about:blank, data:, …). */
export function urlOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}
