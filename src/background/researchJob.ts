// =============================================================================
// Deep-research job type for the durable job engine. A growing frontier of
// sources is browsed by read-only scoped sub-agents (each in its own background
// tab, closed after use), then synthesized into a cited report saved to the
// Products store. Registers itself with the engine on import.
//
//   seed:     objective → focused subqueries (depth-0 frontier)
//   runItem:  a `query` item searches the web → yields source-URL leads;
//             a `url` item reads that source → yields facts + follow-up leads
//   reduce:   all findings → a markdown research report (productStore)
// =============================================================================

import type { Settings } from '../shared/types';
import type { FrontierItem, JobRecord } from '../shared/jobs';
import { seedFrontier, type FrontierState } from '../shared/jobs';
import { complete, resolveModelForRole } from './llmProvider';
import { TOOL_NAMES } from '../shared/tools';
import { extractJsonObject, runScopedSubtask, SCOPED_SUBTASK_TOOLS } from './scopedSubtask';
import { registerJobType, type JobItemOutcome, type JobTypeHandler } from './jobEngine';
import type { JobFinding } from './jobStore';
import * as browser from './browserToolAdapter';
import { extractOffice, extractPdf, productSave } from './offscreenClient';

// Read-only web tools the research sub-agent may use (subset of the scoped set).
const RESEARCH_TOOL_NAMES = new Set<string>([
  TOOL_NAMES.search_web,
  TOOL_NAMES.open_url,
  TOOL_NAMES.get_tab_content,
  TOOL_NAMES.get_active_tab,
  TOOL_NAMES.read_pdf,
  TOOL_NAMES.read_office_document,
  TOOL_NAMES.read_app_content,
]);
const RESEARCH_TOOLS = SCOPED_SUBTASK_TOOLS.filter((t) => RESEARCH_TOOL_NAMES.has(t.function.name));

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'research';
}

function isHttp(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/**
 * A standalone read-only dispatcher for research sub-agents. Opens tabs in the
 * background (searchWeb/openUrl already do), tracks them, and closes them after
 * the item so tab count stays ≈ concurrency.
 */
function makeResearchDispatch(): { dispatch: (name: string, args: Record<string, unknown>) => Promise<string>; closeTabs: () => Promise<void> } {
  const opened: number[] = [];
  const dispatch = async (name: string, args: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case 'search_web': {
        const r = await browser.searchWeb(String(args.query ?? ''));
        if (r.tabId > 0) opened.push(r.tabId);
        return JSON.stringify(r);
      }
      case 'open_url': {
        const r = await browser.openUrl(String(args.url ?? ''));
        if (r.tabId > 0) opened.push(r.tabId);
        return JSON.stringify(r);
      }
      case 'get_active_tab':
        return JSON.stringify(await browser.getActiveTab());
      case 'get_tab_content':
        return JSON.stringify(await browser.getTabContent(Number(args.tabId)));
      case 'read_app_content':
        return await browser.readAppContent(Number(args.tabId));
      case 'read_pdf':
        return JSON.stringify(await extractPdf(String(args.url ?? '')));
      case 'read_office_document':
        return JSON.stringify(await extractOffice(String(args.url ?? '')));
      default:
        return `Error: tool ${name} is not available in a research job.`;
    }
  };
  const closeTabs = async (): Promise<void> => {
    for (const id of opened.splice(0)) {
      try {
        await chrome.tabs.remove(id);
      } catch {
        // tab already gone
      }
    }
  };
  return { dispatch, closeTabs };
}

const handler: JobTypeHandler = {
  async seed(settings: Settings, job: JobRecord): Promise<FrontierState> {
    let queries: string[] = [];
    try {
      const reply = await complete(
        { ...resolveModelForRole(settings, 'plan'), maxTokens: 300, temperature: 0 },
        [
          { role: 'system', content: 'You decompose a research objective into focused web-search queries. Reply ONLY JSON: {"queries":["...", ...]} with 3–6 distinct queries. No prose.' },
          { role: 'user', content: `Objective: ${job.objective}` },
        ],
      );
      const obj = extractJsonObject(reply.content ?? '{}') as { queries?: unknown };
      queries = Array.isArray(obj.queries) ? obj.queries.map(String).map((q) => q.trim()).filter(Boolean).slice(0, 6) : [];
    } catch {
      // fall through to the objective as a single query
    }
    if (queries.length === 0) queries = [job.objective];
    return seedFrontier(queries);
  },

  async runItem(settings: Settings, job: JobRecord, item: FrontierItem, signal: AbortSignal): Promise<JobItemOutcome> {
    const { dispatch, closeTabs } = makeResearchDispatch();
    const objective = item.query
      ? `Search the web for "${item.query}" and identify the most relevant, credible source URLs for the overall research objective: "${job.objective}". Read the results page. In your JSON, set "conclusion" to a one-line note on what's available and "sources" to the specific result URLs worth reading next (up to 5, full https URLs).`
      : `Read ${item.url} and extract the facts relevant to the research objective: "${job.objective}". In your JSON, set "conclusion" to the key facts found (concise) and "sources" to ${item.url} plus up to 3 highly-relevant links worth following (full https URLs).`;
    let result;
    try {
      result = await runScopedSubtask(
        settings,
        { id: item.id, objective, ...(item.url ? { url: item.url } : {}) },
        { maxSteps: job.limits.perItemMaxSteps, dispatch, tools: RESEARCH_TOOLS, signal, shouldStop: () => signal.aborted },
      );
    } finally {
      await closeTabs();
    }
    const finding: JobFinding = {
      itemId: item.id,
      depth: item.depth,
      url: item.url,
      query: item.query,
      conclusion: result.conclusion,
      sources: result.sources,
      at: new Date().toISOString(),
      error: result.error,
    };
    // Leads: source URLs to follow, minus this item's own URL. The engine
    // dedups and enforces depth/source caps.
    const own = item.url ? item.url.split('#')[0].replace(/\/+$/, '') : '';
    const leads = result.sources
      .filter((s) => isHttp(s) && s.split('#')[0].replace(/\/+$/, '') !== own)
      .map((url) => ({ url }));
    return { finding, leads };
  },

  async reduce(settings: Settings, job: JobRecord, findings: JobFinding[]): Promise<string> {
    const usable = findings.filter((f) => f.conclusion && !f.error);
    const notes = usable
      .map((f, i) => `[${i + 1}] ${f.url ?? f.query ?? ''}\n${f.conclusion}`)
      .join('\n\n')
      .slice(0, 24000);
    const allSources = [...new Set(usable.flatMap((f) => f.sources).filter(isHttp))];

    let body = '';
    try {
      const reply = await complete(
        { ...resolveModelForRole(settings, 'reflection'), maxTokens: 2000, temperature: 0.2 },
        [
          { role: 'system', content: 'You are a research synthesist. Write a well-structured Markdown report answering the objective from the collected findings. Use headings, be specific, note disagreements/uncertainty, and cite sources inline as [n] matching the numbered findings. Do not invent facts beyond the findings.' },
          { role: 'user', content: `Objective: ${job.objective}\n\nFindings:\n${notes}` },
        ],
      );
      body = (reply.content ?? '').trim();
    } catch (e) {
      body = `_Synthesis step failed (${e instanceof Error ? e.message : String(e)}). Raw findings below._`;
    }

    const report =
      `# ${job.title}\n\n` +
      `**Objective:** ${job.objective}\n\n` +
      `_${usable.length} sources analyzed · generated ${new Date().toLocaleString()}_\n\n` +
      `${body}\n\n## Sources\n\n${allSources.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;

    const filename = `research-${slug(job.title)}-${new Date().toISOString().slice(0, 10)}.md`;
    await productSave(filename, 'text/markdown', utf8ToBase64(report), { sourceTitle: job.title });
    return filename;
  },
};

registerJobType('research', handler);
