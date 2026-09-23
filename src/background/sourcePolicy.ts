import type { ToolDefinition } from './llmTypes';

export type SourcePolicy =
  | { mode: 'unrestricted' }
  | { mode: 'repo_only'; repos: string[]; webApproved: boolean };

// Tools that can acquire factual content outside the explicitly selected local
// repository. Output-only and planning tools remain available in repo-only mode.
export const EXTERNAL_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  'search_web',
  'open_url',
  'navigate',
  'get_tab_content',
  'get_all_tab_contents',
  'read_tab_group',
  'read_app_content',
  'read_pdf',
  'read_office_document',
  'get_video_transcript',
  'search_known_sites',
  'sharepoint_search',
  'microsoft365_search',
  'calendar_search',
  'list_mcp_tools',
  'call_mcp_tool',
  'list_webmcp_tools',
  'call_webmcp_tool',
  'run_subtasks',
  'start_research_job',
]);

export function normalizeRepoName(name: string): string {
  return name.trim().toLowerCase();
}

export function sourcePolicyForRepos(repos: string[]): SourcePolicy {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of repos) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeRepoName(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique.length > 0 ? { mode: 'repo_only', repos: unique, webApproved: false } : { mode: 'unrestricted' };
}

export function sourceToolAllowed(policy: SourcePolicy, toolName: string): boolean {
  if (policy.mode === 'unrestricted' || policy.webApproved) return true;
  return !EXTERNAL_SOURCE_TOOLS.has(toolName);
}

export function sourceRepositoryAllowed(policy: SourcePolicy, repo: string): boolean {
  if (policy.mode !== 'repo_only') return true;
  const key = normalizeRepoName(repo);
  return policy.repos.some((r) => normalizeRepoName(r) === key);
}

export function toolsForSourcePolicy(policy: SourcePolicy, tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => {
    if (tool.function.name === 'request_web_fallback') return policy.mode === 'repo_only' && !policy.webApproved;
    return sourceToolAllowed(policy, tool.function.name);
  });
}

export function sourcePolicyPrompt(policy: SourcePolicy): string {
  if (policy.mode !== 'repo_only' || policy.webApproved) return '';
  return (
    `\n\nRepository-prioritized source policy (enforced by the runtime): prioritize searching and answering from ${policy.repos.map((repo) => `"${repo}"`).join(', ')}. ` +
    'Search the selected repository first with search_repo (and search_graph/global_search when appropriate) and answer from its passages; the repository passages attached to this request were already retrieved for you. ' +
    'Do not use browser pages, web search, external services, MCP, or your own factual knowledge as evidence before searching the selected repository. ' +
    'If repository evidence is insufficient after searching, call request_web_fallback with a plain-language reason. The user must approve before external tools become available. ' +
    'If approval is denied, state that the repository does not contain enough evidence.'
  );
}

/** Active-tab summary used to decide how a knowledge-base-less prompt is grounded. */
export interface GroundingTab {
  url: string;
  title: string;
}

const NON_PAGE_URL = /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-untrusted|file):/i;

/** True when the tab is a real http(s) page the agent can read (not a new-tab/browser-internal surface). */
export function isGroundableTab(tab: GroundingTab | null | undefined): tab is GroundingTab {
  return !!tab && /^https?:/i.test(tab.url) && !NON_PAGE_URL.test(tab.url);
}

/**
 * Grounding order for an unrestricted (no knowledge base selected) turn:
 *  1. the active tab, when the request plausibly concerns it;
 *  2. otherwise a from-scratch agentic web search through the browser.
 * The relevance call is the model's; the runtime only decides whether step 1 is
 * available at all (a readable http(s) tab) and states the fallback either way.
 */
export function groundingDirective(policy: SourcePolicy, tab: GroundingTab | null | undefined): string {
  if (policy.mode !== 'unrestricted') return '';
  const webSearch =
    'Start from scratch with agentic web research through the browser: search_web for the topic, open_url the most relevant results, read them, ' +
    'refine the search when the first results are thin, and answer from what you read, citing the pages.';
  if (!isGroundableTab(tab)) {
    return `\n\n[No knowledge base is selected and there is no readable active tab. ${webSearch}]`;
  }
  const label = `"${tab.title.replace(/"/g, '')}" ${tab.url}`;
  return (
    `\n\n[No knowledge base is selected, so apply this request to the active tab: ${label}. ` +
    'Call get_tab_content on it first and answer from that page. ' +
    `If the request does not make sense for this page (it is about something else, or the page has no relevant content), do not force it: ${webSearch}]`
  );
}
